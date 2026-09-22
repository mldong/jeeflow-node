// 委托查询判据的**单一事实源**（issues/116 判据 a~d + issues/123 的取行/裁决顺序）。
//
// 契约依据：jeeflow-doc spec `06-facade.md` §4.5 条款 1.4/5/6 + `08-compliance.md` 用例 27。
// 条款 6 要求**内存仓与 SQL 仓两条路径都要满足判据**，同栈两仓给出不同结论即缺陷，
// 故两侧共用本文件的同一份谓词（姿势对齐 PHP 的 `SurrogateRule`、Python 的 `surrogate.py`）。
//
// ⚠️ issues/123：取行与裁决的**顺序不可颠倒**——
//   ① 先在流程作用域内按主键 id 取**最新一条**（{@link newestOf} / SQL `ORDER BY id DESC LIMIT 1`，
//      不带任何生效判据过滤）；
//   ② 再由 {@link surrogateIsEffective} 裁决**这一条**；
//   ③ 同层内不生效即"未命中"，不回落到更旧那条；但精确作用域判否（含池空）后仍要看
//      全流程作用域（processName 为空）的最新一条——条款 1.4 后半句。Java 参考实现的既有
//      测试 JdbcProcessExtRepositoryTest#testSurrogateCrudAndGet 钉的是「精确已过期 → 兜底全流程」。
// 反过来写（先用 ② 的判据把记录滤掉、剩下的才取最新）等价于"同一授权人历史上留过一条
// 窗内 enabled=1 的记录就永久生效"，用户随后新建的窗外 / enabled=0 / 脏值 / 自委托记录
// 全都判不动它——这正是 issues/123 里 13 栈 L2-17/L2-18 全红的病灶。

import type { ProcessSurrogate } from './model.js'

/** 时间归一为毫秒：Date/毫秒数/可解析字符串均可；空值或脏值 → null（该侧不限，对齐 SQL 侧 NULL） */
export function surrogateTimeMs(v: any): number | null {
  if (v == null || v === '') return null
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime()
  if (typeof v === 'number') return Number.isNaN(v) ? null : v
  if (typeof v === 'string') {
    // 兼容 'yyyy-MM-dd HH:mm:ss'（Safari/Node 对空格分隔不统一，转 T 再解）
    const n = Date.parse(v.trim().replace(' ', 'T'))
    return Number.isNaN(n) ? null : n
  }
  return null
}

/** enabled 只认整数 1（'1' 视作 1，与 SQL 侧 INT 列同结论）；脏值（'abc'/true/0/2/空）一律不启用 */
export function surrogateEnabled(v: any): boolean {
  if (typeof v === 'number') return v === 1
  if (typeof v === 'string') {
    const s = v.trim()
    return s !== '' && Number.isInteger(Number(s)) && Number(s) === 1
  }
  return false
}

/**
 * 判据 1.4：比较两条委托的主键大小（a 是否比 b 旧）。id 是雪花数字串（19 位，已超
 * Number 安全整数），纯数字串一律按 BigInt 比**数值**（与 SQL 侧 `ORDER BY id DESC` 同序），
 * 非数字 id 退化为字符串序。
 *
 * ⚠️ 不能拿 Map 的插入序当 id 序：saveSurrogate/updateSurrogate 都接受调用方显式 id，
 * 乱序写入（补录、导入、双仓对拍）时"取遍历到的末条"就会与 SQL 仓给出不同答案。
 * Go 内存仓原实现正是"map 随机序取到啥算啥"被抓出来重写的（issues/116 §5）。
 */
export function surrogateIdLess(a: any, b: any): boolean {
  const sa = String(a ?? ''), sb = String(b ?? '')
  if (/^\d+$/.test(sa) && /^\d+$/.test(sb)) return BigInt(sa) < BigInt(sb)
  return sa < sb
}

/**
 * 单条裁决（规范 06 §4.5 条款 5 四判据 + issues/123）：这一行委托此刻对该授权人生效吗。
 *
 * 调用方**必须**先按 id 选出「该授权人在该流程作用域内的最新一条」再问本函数——
 * 本函数只裁决单条，不做多条择优（择优规则见文件头的 ①②③）。
 *
 * @param s      待裁决的委托行（null = 该作用域内没有记录）
 * @param operator 授权人（判自委托：被委托人等于授权人 ⇒ 不新增、不重复）
 * @param atMs   判定时刻（毫秒）；传 null 表示不做窗口比较
 *               （保留 `getSurrogate(..., at)` 显式传 null 时整段跳过窗比较的入参语义）
 */
export function surrogateIsEffective(
  s: ProcessSurrogate | null | undefined, operator: string, atMs: number | null,
): boolean {
  if (!s) return false
  if (!surrogateEnabled((s as any).enabled)) return false        // d 只认整数 1
  const agent = typeof s.surrogate === 'string' ? s.surrogate.trim() : String((s as any).surrogate ?? '')
  if (agent === '' || agent === operator) return false           // c 自委托过滤（含代理人为空）
  if (atMs == null) return true                                  // 调用方没给时刻 ⇒ 不比较窗口
  const start = surrogateTimeMs((s as any).startTime)
  const end = surrogateTimeMs((s as any).endTime)
  if (start != null && start > atMs) return false                 // b 一侧为空 = 该侧不限
  if (end != null && end < atMs) return false
  return true
}

/**
 * 判据 1.4 的取行：候选里主键 id 最大（最新）的那一条，**不带**任何生效判据过滤。
 * 空池返回 null。SQL 侧对应 `ORDER BY id DESC LIMIT 1`。
 */
export function newestOf<T extends { id: any }>(rows: Iterable<T>): T | null {
  let hit: T | null = null
  for (const r of rows) {
    if (hit == null || surrogateIdLess(hit.id, r.id)) hit = r
  }
  return hit
}
