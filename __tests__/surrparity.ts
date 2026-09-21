// 委托查询「条款 1.4 多条命中取 id 最大」的**共用数据集与期望表**（issues/116 收尾批次 D，
// 姿势对齐 Python 栈 tests/surrparity.py）。
//
// 契约依据：jeeflow-doc spec 06 §4.5「运行期语义」条款 1.4 + 第 5 条判据 a~d + 第 6 条
// （内存仓与 SQL 仓两条路径都要满足，同栈两仓给出不同结论即缺陷）。
//
// 调用方（**数据与期望只写在本文件这一处**，两侧各跑一遍比对同一份期望，防"两边各造一份
// 断言"漂移）：
//   - 内存仓侧：__tests__/spec.test.ts（npm test，无 DB 依赖）
//   - 真机 SQL 仓侧：__tests__/jdbc.test.ts（npm run test-mysql / JEFFLOW_DB=postgres）
//
// ⚠️ 夹具的 id 序是**刻意打乱**的（条款 1.4 判别力所在）：多命中组按插入顺序给 id 偏移
// `+2 → +3 → +1`（兜底组 `+42 → +43 → +41`），期望命中的最大 id 行**既不是插入首条、
// 也不是插入末条**——"取遍历首条 / 取插入末条 / 边扫边覆盖"的错实现都会红。
// 判别力由 verifyParityFixtures() **独立重算**四判据 + 取最大规则自证（刻意不复用被测
// 仓储的谓词，避免自证与实现同源共错），并核对期望行落在插入序**中间**。
//
// ⚠️ 已知事实（Java/Go/Python 实测踩到，写在这里免得误以为 SQL 侧也在起判别力）：
// SQL 侧 `WHERE operator = ? ... ORDER BY id DESC LIMIT 1` 本来就按主键序回行，
// **插入序在结果里根本不出现**，打乱与否答案都一样 ⇒ "打乱 id 序"在 SQL 侧没有判别力；
// 真正钉住条款 1.4 的是 SQL 里的 `ORDER BY id DESC` 子句本身（去掉它退化成"取物理首行"）。
// 内存侧（Map 按插入序遍历）才是打乱序起作用的地方。两侧仍各跑一遍，并对**同一份答案**负责
// （jdbc 侧逐条比对两仓命中同一 id）。
//
// 时间窗判据 b / enabled 脏值等其余判据的双仓对拍在 jdbc.test.ts
// 「issues/116 用例27 判据双仓一致」既有用例；本夹具专注 1.4 与"过滤判据先于取最大"
// （停用行 id_off 6、自委托行 id_off 8 都**大于**期望行 3——漏任何一条过滤都会被
// "取 id 最大"放大成错答案）。内存侧"打乱序 + 字典序退化"的判别另见 spec.test.ts
// 「条款 1.4」用例的 900/1000/950 三元组（'900003'-style 等长 id 字典序=数值序，
// 只有混合长度 id 才能抓 BigInt 退化）。

import type { ProcessSurrogate } from '../src/model.js'

const FLOW = 'parity116'
const OTHER_FLOW = 'other116'

/** 授权人/代理人统一挂 n116p- 前缀（jdbc 侧 cleanupN116 的 LIKE 'n116-%' 顺带覆盖） */
const op = (s: string) => `n116p-${s}`
const ag = (s: string) => `n116p-${s}`

export interface ParityRow {
  /** 真实 id = baseId + idOff。idOff 序刻意非单调（打乱），见文件头注释 */
  idOff: number
  operator: string
  surrogate: string
  /** '' 与 null 同属"全流程兜底"逻辑类，两侧行为都要一致 */
  processName: string | null
  enabled: number
}

export interface ParityCase {
  what: string
  operator: string
  processName: string
  /** '' = 期望不命中 */
  want: string
}

/** 插入顺序即数组顺序——判别力设计依赖这个顺序（期望行落在中间位） */
export const PARITY_ROWS: ParityRow[] = [
  // ── 精确多命中组（zs/parity116）：插入 id 偏移 +2 → +3 → +1，期望 +3（数值最大、插入中间）──
  { idOff: 2, operator: op('zs'), surrogate: ag('ex-first'), processName: FLOW, enabled: 1 },
  { idOff: 3, operator: op('zs'), surrogate: ag('ex-max'), processName: FLOW, enabled: 1 },
  { idOff: 1, operator: op('zs'), surrogate: ag('ex-last'), processName: FLOW, enabled: 1 },
  // 停用行 id(6) > 期望行 id(3)：enabled 过滤若漏/宽松，取最大会答成 disabled
  { idOff: 6, operator: op('zs'), surrogate: ag('disabled'), processName: FLOW, enabled: 0 },
  // 自委托行 id(8) 全组最大：自委托过滤若漏，取最大会答成 operator 自己
  { idOff: 8, operator: op('zs'), surrogate: op('zs'), processName: FLOW, enabled: 1 },
  // 兜底行（id 5）：未精确命中的查询落它
  { idOff: 5, operator: op('zs'), surrogate: ag('all-flow'), processName: '', enabled: 1 },
  // 异流程名行 id(7) > 兜底行 id(5)：兜底若"判空不严"（把非空 processName 当兜底）会答成它
  { idOff: 7, operator: op('zs'), surrogate: ag('other-flow'), processName: OTHER_FLOW, enabled: 1 },
  // ── 兜底多命中组（zs2，空流程名）：插入 +42 → +43 → +41，期望 +43 且它是 **NULL** 行 ──
  { idOff: 42, operator: op('zs2'), surrogate: ag('all2-first'), processName: '', enabled: 1 },
  { idOff: 43, operator: op('zs2'), surrogate: ag('all2-max'), processName: null, enabled: 1 },
  { idOff: 41, operator: op('zs2'), surrogate: ag('all2-last'), processName: '', enabled: 1 },
  // ── 自委托过滤组（zs3）：自委托行 id(9) > 生效行 id(4)，过滤必须发生在"取最大"之前 ──
  { idOff: 9, operator: op('zs3'), surrogate: op('zs3'), processName: FLOW, enabled: 1 },
  { idOff: 4, operator: op('zs3'), surrogate: ag('ok'), processName: FLOW, enabled: 1 },
]

/** 共用期望表（'' = 期望不命中）。两侧对拍 + 独立重算都吃这份，不各造一份 */
export const PARITY_CASES: ParityCase[] = [
  { what: 'p1 多条精确命中取 id 最大（插入序 +2→+3→+1：期望行非首条、非末条；停用/自委托大 id 行不得入选）',
    operator: op('zs'), processName: FLOW, want: ag('ex-max') },
  { what: 'p2 未精确命中 → 全流程兜底（id 更大的非空 processName 行不得充当兜底）',
    operator: op('zs'), processName: 'nomatch116', want: ag('all-flow') },
  { what: 'p3 查询传空流程名 = 只走兜底分支（不得拿大 id 精确行作答）',
    operator: op('zs'), processName: '', want: ag('all-flow') },
  { what: 'p4 兜底分支多条命中同样取 id 最大（期望行 processName 为 NULL，兜底不得只判 = \'\'）',
    operator: op('zs2'), processName: FLOW, want: ag('all2-max') },
  { what: 'p5 自委托行 id 更大时仍取生效的 id 最大行（精确路径）',
    operator: op('zs3'), processName: FLOW, want: ag('ok') },
  { what: 'p6 无该授权人记录 → null（正向对照：其余组均有命中，排除"整批没落库"空转）',
    operator: op('nobody'), processName: FLOW, want: '' },
]

/** 结构型接口：MemoryExtRepository / JdbcProcessExtRepository 都天然满足 */
export interface SurrogateQueryRepo {
  saveSurrogate(s: ProcessSurrogate): Promise<void>
  findSurrogateById(id: string): Promise<ProcessSurrogate | null>
  getSurrogate(operator: string, processName: string, at?: Date): Promise<ProcessSurrogate | null>
}

/**
 * 判别力自证：**独立重算**四判据 + 取最大规则（不复用被测仓储实现），核对
 * ①期望表与数据集自洽；②多命中组（≥2 条同时生效）的期望行落在插入序**中间**。
 * 返回问题列表（空 = 夹具合格），两侧都先跑它。
 */
export function verifyParityFixtures(): string[] {
  const problems: string[] = []
  for (const c of PARITY_CASES) {
    const cands = PARITY_ROWS.filter(r =>
      r.operator === c.operator && r.surrogate !== r.operator && r.enabled === 1)
    const pool = c.processName
      ? (cands.filter(r => r.processName === c.processName).length
        ? cands.filter(r => r.processName === c.processName)
        : cands.filter(r => !r.processName))
      : cands.filter(r => !r.processName)
    const got = pool.length ? pool.reduce((a, b) => (a.idOff >= b.idOff ? a : b)) : null
    if (c.want === '') {
      if (pool.length) problems.push(`${c.what}：期望不命中，但数据里有 ${pool.length} 条同时生效候选（${pool.map(r => r.surrogate)}）`)
      continue
    }
    if (!got) { problems.push(`${c.what}：期望命中 ${c.want}，但数据里没有任何生效候选行——负向期望会因"根本没数据"空转通过`); continue }
    if (got.surrogate !== c.want) {
      problems.push(`${c.what}：按条款 1.4 应命中 ${got.surrogate}(id_off=${got.idOff})，期望表却写了 ${c.want}——期望与规则不自洽`)
      continue
    }
    if (pool.length >= 2) {
      const idx = pool.findIndex(r => r.idOff === got.idOff)
      if (idx === 0 || idx === pool.length - 1) {
        problems.push(`夹具失去判别力：${c.what} 有 ${pool.length} 条同时命中（插入序 id_off ${pool.map(r => r.idOff)}），期望那条落在第 ${idx + 1} 位（首位/末位）——「取遍历首条」「取插入末条」的错实现会跟着一起绿`)
      }
    }
  }
  return problems
}

/** Row → ProcessSurrogate（显式 string id；两侧共用同一映射，唯一差异是 baseId） */
export function toParitySurrogate(r: ParityRow, baseId: number): ProcessSurrogate {
  const now = new Date()
  return {
    id: String(baseId + r.idOff),
    processName: r.processName ?? undefined,
    operator: r.operator,
    surrogate: r.surrogate,
    enabled: r.enabled,
    createTime: now, createUser: 'n116p', updateTime: now, updateUser: 'n116p',
  }
}

/**
 * 同一份数据 + 同一份期望跑一仓：夹具自证 → 落库 → 逐行按显式 id 读回自证
 * （缺这步时"不命中"类期望会因数据没进去而空转通过，issues/113 教训）→ 逐条期望对拍。
 * 返回本轮落库的 id 列表，供 SQL 侧按 id 精确清理。
 */
export async function runParity(
  ext: SurrogateQueryRepo, baseId: number,
  report: (desc: string, ok: boolean, detail?: string) => void,
): Promise<string[]> {
  const problems = verifyParityFixtures()
  report('夹具自证：期望表与数据自洽，且多命中组期望行落在插入序中间（打乱 id 序真起判别力）',
    problems.length === 0, problems.join('；'))

  const ids: string[] = []
  for (const r of PARITY_ROWS) {
    await ext.saveSurrogate(toParitySurrogate(r, baseId))
    ids.push(String(baseId + r.idOff))
  }

  const missing: string[] = []
  for (const r of PARITY_ROWS) {
    const back = await ext.findSurrogateById(String(baseId + r.idOff))
    if (!back || back.surrogate !== r.surrogate || back.operator !== r.operator) {
      missing.push(`id=${baseId + r.idOff} 读回 ${back ? back.surrogate : 'null'}`)
    }
  }
  report('种子自证：全部委托行按显式 id 读回一致（真落库，期望不是空转）', missing.length === 0, missing.slice(0, 3).join('；'))

  for (const c of PARITY_CASES) {
    const hit = await ext.getSurrogate(c.operator, c.processName)
    const got = hit?.surrogate ?? ''
    report(c.what, got === c.want, `want=${JSON.stringify(c.want)} got=${JSON.stringify(got)}`)
  }
  return ids
}
