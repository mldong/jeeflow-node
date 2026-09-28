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

/**
 * enabled **只认整数 1**（issues/130 案 A）：与 Java `Integer.valueOf(1).equals(enabled)`、
 * Go `Enabled int != 1` 同阵营——字符串 `'1'`/`'1.0'`、布尔 `true`、`null`/`undefined` 及
 * 0/2 等其它整数一律停用，不接受任何"看起来像 1"的等价写法。
 *
 * ⚠️ 这不是"与 SQL 侧 `enabled = 1` 隐式转换等价"：SQL 的宽松数值比较（MySQL 甚至 `'abc'=0`）
 * 是**驱动/连接层**改写列值的历史包袱，不是运行期裁决该追随的口径（见 issues/130 附加义务：
 * 驱动/连接层不得改写 enabled 原值）。
 *
 * ⚠️ 判据本身**不吃串**，所以"整数列在边界上变成字符串"必须由**边界**还原（{@link surrogateHydrateEnabled}），
 * 三个内置边界各管一段，都不动本判据：
 *   - SQL 仓读侧（`JdbcProcessExtRepository.queryNewestSurrogate`）：驱动把 INT 列回读成 `'1'`；
 *   - 内存仓写侧（`MemoryExtRepository.saveSurrogate`）：台账建模的是 INT 列，调用方直传
 *     规范整数串时按列语义落数值（门面 `processSurrogate/*` 的写侧归一只覆盖 API 入口，
 *     绕过门面的仓储直写属这一段）；
 *   - 业务方自定义 SPI 仓储传非整数 enabled 属 issues/130 §2 的分叉源，由实现侧自己归一。
 */
export function surrogateEnabled(v: any): boolean {
  // typeof 先过：'1'/'1.0'/true/null 皆非 number 直接停；Number.isInteger + === 1 双闸，
  // 排除 2/0/NaN/小数——只有整数 1 通过。
  return typeof v === 'number' && Number.isInteger(v) && v === 1
}

/**
 * **边界还原**：把整数列被驱动字符串化 / 调用方按文本传进来的**规范整数串**换回数值，
 * 再交 {@link surrogateEnabled} 裁决（姿势对齐 PHP `SurrogateRule::hydrateEnabled`、
 * Java `rs.getInt`、Go `Scan(&int)`、C# `GetFieldValue<int>`）。
 *
 * 为什么需要：`wf_process_surrogate.enabled` 是 `INT` 列（tests/schema/schema-mysql.sql），
 * 但驱动不保证给回数值——mysql2 关掉 typeCast、pg 的 int8/numeric、以及任何"文本协议"驱动都会
 * 给字符串 `'1'`。判据只认数值 1 之后不在边界还原，就会让这类宿主的委托**整体判废且零告警**。
 *
 * ⚠️ 这**不是**把接受集合放宽回去：只认规范整数串 `-?(0|[1-9]\d*)`（无空格、无前导零、无小数点、
 * 无加号），`'1.0'` / `' 1'` / `'01'` / `'+1'` / `'1abc'` / `'abc'` / `''` 以及 `true` / `null`
 * 一律**原样返回**，交判据判停用。非字符串入参（数值/布尔/null）同样原样透传。
 */
export function surrogateHydrateEnabled(v: any): any {
  if (typeof v === 'string' && /^-?(0|[1-9]\d*)$/.test(v)) return Number(v)
  return v
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
