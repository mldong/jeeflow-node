// 委托查询「取行 + 裁决」的**共用数据集与期望表**（issues/116 收尾批次 D + issues/123，
// 姿势对齐 Python 栈 tests/surrparity.py、Go 栈 internal/surrparity）。
//
// 契约依据：jeeflow-doc spec 06 §4.5「运行期语义」条款 1.4 + 第 5 条判据 a~d + 第 6 条
// （内存仓与 SQL 仓两条路径都要满足，同栈两仓给出不同结论即缺陷）。
//
// ⚠️ 顺序（issues/123 的核心，本夹具按此建期望）：
//   ① 先按主键 id 在该流程作用域内取**最新一条**（不带任何生效判据过滤）；
//      该作用域一条记录都没有，才看 process_name 为空的全流程兜底作用域；
//   ② 再由四判据裁决**这一条**（d enabled 严格 1 / c 自委托过滤 / b 时间窗，单侧空=不限）；
//   ③ 同层内不生效 ⇒ 未命中（不回落更旧那条）；精确作用域判否后仍看全流程作用域兜底行。
// 反过来写（先用判据滤掉、剩下的才取最新）= "历史上留过一条窗内委托就永久生效"，
// 用户随后新建的窗外/停用/脏值/自委托记录全都判不动它 —— issues/123 里 13 栈 L2-17/L2-18
// 全红的病灶。旧夹具的 p5「自委托行 id 更大时仍取生效的 id 最大行」正是这种错法的期望，
// issues/123 已把它改写成 st-* / g1 / h1 组「最新一条不生效 ⇒ 不命中且不回落」。
//
// 调用方（**数据与期望只写在本文件这一处**，两侧各跑一遍比对同一份期望，防"两边各造一份
// 断言"漂移）：
//   - 内存仓侧：__tests__/spec.test.ts（npm test，无 DB 依赖）
//   - 真机 SQL 仓侧：__tests__/jdbc.test.ts（npm run test-mysql / JEFFLOW_DB=postgres）
//
// ⚠️ 夹具的 id 序是**刻意打乱**的（条款 1.4 判别力所在）：裁决行（id 最大那条）在插入序里
// 既不是首条也不是末条——"取遍历首条 / 取插入末条 / 边扫边覆盖"的错实现都会红。
// 负向组（st-*/g1/h1）同理必须三条：裁决行夹在两条"更旧的生效行"中间，否则
// "取插入末条"的实现会因为末条恰好是裁决行而跟着夹具一起绿（判别力自证会当场红）。
// 判别力由 verifyParityFixtures() **独立重算**取行 + 四判据自证（刻意不复用被测仓储的谓词，
// 避免自证与实现同源共错）。
//
// ⚠️ 已知事实（Java/Go/Python 实测踩到，写在这里免得误以为 SQL 侧也在起判别力）：
// SQL 侧 `WHERE operator = ? ... ORDER BY id DESC LIMIT 1` 本来就按主键序回行，
// **插入序在结果里根本不出现**，打乱与否答案都一样 ⇒ "打乱 id 序"在 SQL 侧没有判别力；
// 真正钉住条款 1.4 的是 SQL 里的 `ORDER BY id DESC` 子句本身（去掉它退化成"取物理首行"）。
// 内存侧（Map 按插入序遍历）才是打乱序起作用的地方。两侧仍各跑一遍，并对**同一份答案**负责
// （jdbc 侧逐条比对两仓命中同一 id）。

import type { ProcessSurrogate } from '../src/model.js'

const FLOW = 'parity116'
const OTHER_FLOW = 'other116'
/** 一天的毫秒数——窗口/查询时刻都用"相对 now 的天偏移"表达，夹具不随挂钟过期 */
export const DAY = 86400000

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
  /** 时间窗边界（相对 now 的天偏移）；省略 = 该侧 NULL = 该侧不限 */
  startOffDays?: number
  endOffDays?: number
}

export interface ParityCase {
  what: string
  operator: string
  processName: string
  /** 查询时刻 = now + queryOffDays 天（默认 0）；b 判据的"未来时刻再查一次"靠它 */
  queryOffDays?: number
  /** '' = 期望不命中 */
  want: string
}

/** 窗内模板（覆盖 now）：几乎所有"生效行"都用它 */
const WIN = { startOffDays: -1, endOffDays: 1 }

/** 插入顺序即数组顺序——判别力设计依赖这个顺序（裁决行落在插入序中间） */
export const PARITY_ROWS: ParityRow[] = [
  // ── 精确多命中组（zs/parity116）：插入 id 偏移 +2 → +3 → +1，期望 +3（数值最大、插入中间）──
  { idOff: 2, operator: op('zs'), surrogate: ag('ex-first'), processName: FLOW, enabled: 1, ...WIN },
  { idOff: 3, operator: op('zs'), surrogate: ag('ex-max'), processName: FLOW, enabled: 1, ...WIN },
  { idOff: 1, operator: op('zs'), surrogate: ag('ex-last'), processName: FLOW, enabled: 1, ...WIN },
  // 兜底行（id 5）：未精确命中的查询落它
  { idOff: 5, operator: op('zs'), surrogate: ag('all-flow'), processName: '', enabled: 1, ...WIN },
  // 异流程名行 id(7) > 兜底行 id(5)：兜底若"判空不严"（把非空 processName 当兜底）会答成它
  { idOff: 7, operator: op('zs'), surrogate: ag('other-flow'), processName: OTHER_FLOW, enabled: 1, ...WIN },
  // 委托给"同名用户"≠自委托：代理人叫 self-go…（字符串不同于授权人）
  { idOff: 9, operator: op('zs'), surrogate: ag('namesake'), processName: ag('namesake'), enabled: 1, ...WIN },
  // ── 兜底多命中组（zs2，空流程名）：插入 +42 → +43 → +41，期望 +43 且它是 **NULL** 行 ──
  { idOff: 42, operator: op('zs2'), surrogate: ag('all2-first'), processName: '', enabled: 1, ...WIN },
  { idOff: 43, operator: op('zs2'), surrogate: ag('all2-max'), processName: null, enabled: 1, ...WIN },
  { idOff: 41, operator: op('zs2'), surrogate: ag('all2-last'), processName: '', enabled: 1, ...WIN },

  // ── 单判据隔离组（每个作用域只有一条，答错无法被其它判据掩盖）──
  { idOff: 10, operator: op('solo-expired'), surrogate: ag('agent'), processName: FLOW, enabled: 1, startOffDays: -5, endOffDays: -3 },
  { idOff: 11, operator: op('solo-future'), surrogate: ag('agent'), processName: FLOW, enabled: 1, startOffDays: 3, endOffDays: 5 },
  { idOff: 12, operator: op('solo-halfopen'), surrogate: ag('agent'), processName: FLOW, enabled: 1, startOffDays: -5 },
  { idOff: 13, operator: op('solo-nowindow'), surrogate: ag('agent'), processName: FLOW, enabled: 1 },
  { idOff: 14, operator: op('solo-disabled'), surrogate: ag('agent'), processName: FLOW, enabled: 0, ...WIN },
  { idOff: 15, operator: op('solo-dirty'), surrogate: ag('agent'), processName: FLOW, enabled: 2, ...WIN },
  { idOff: 16, operator: op('solo-empty'), surrogate: '', processName: FLOW, enabled: 1, ...WIN },
  { idOff: 17, operator: op('solo-self-exact'), surrogate: op('solo-self-exact'), processName: FLOW, enabled: 1, ...WIN },
  { idOff: 18, operator: op('solo-self-all'), surrogate: op('solo-self-all'), processName: '', enabled: 1, ...WIN },
  { idOff: 19, operator: op('solo-self-all'), surrogate: op('solo-self-all'), processName: null, enabled: 1, ...WIN },

  // ── st-*：issues/123 任务 A —— 最新一条不生效 ⇒ 不命中，且不得回落到更旧那条 ──
  // 每组三条、插入序固定「生效行 → 裁决行(id 最大) → 生效行」，首末两位都是生效行，
  // 才能同时问住"取遍历首条""取插入末条""先滤生效再取最大(旧 bug)"三种写法。
  { idOff: 50, operator: op('st-window'), surrogate: ag('w-old1'), processName: FLOW, enabled: 1, ...WIN },
  { idOff: 53, operator: op('st-window'), surrogate: ag('w-newest'), processName: FLOW, enabled: 1, startOffDays: 1, endOffDays: 3 },
  { idOff: 52, operator: op('st-window'), surrogate: ag('w-old2'), processName: FLOW, enabled: 1, ...WIN },

  { idOff: 54, operator: op('st-disabled'), surrogate: ag('d-old1'), processName: FLOW, enabled: 1, ...WIN },
  { idOff: 57, operator: op('st-disabled'), surrogate: ag('d-newest'), processName: FLOW, enabled: 0, ...WIN },
  { idOff: 56, operator: op('st-disabled'), surrogate: ag('d-old2'), processName: FLOW, enabled: 1, ...WIN },

  { idOff: 58, operator: op('st-dirty'), surrogate: ag('x-old1'), processName: FLOW, enabled: 1, ...WIN },
  { idOff: 61, operator: op('st-dirty'), surrogate: ag('x-newest'), processName: FLOW, enabled: 2, ...WIN },
  { idOff: 60, operator: op('st-dirty'), surrogate: ag('x-old2'), processName: FLOW, enabled: 1, ...WIN },

  { idOff: 62, operator: op('st-self'), surrogate: ag('s-old1'), processName: FLOW, enabled: 1, ...WIN },
  { idOff: 65, operator: op('st-self'), surrogate: op('st-self'), processName: FLOW, enabled: 1, ...WIN },
  { idOff: 64, operator: op('st-self'), surrogate: ag('s-old2'), processName: FLOW, enabled: 1, ...WIN },

  { idOff: 66, operator: op('st-empty'), surrogate: ag('e-old1'), processName: FLOW, enabled: 1, ...WIN },
  { idOff: 69, operator: op('st-empty'), surrogate: '', processName: FLOW, enabled: 1, ...WIN },
  { idOff: 68, operator: op('st-empty'), surrogate: ag('e-old2'), processName: FLOW, enabled: 1, ...WIN },

  // ── g1：跨作用域不回落（精确作用域最新一条停用 ⇒ 未命中，哪怕兜底行 id 更大且生效）──
  { idOff: 70, operator: op('scope-nofb'), surrogate: ag('g-old1'), processName: FLOW, enabled: 1, ...WIN },
  { idOff: 72, operator: op('scope-nofb'), surrogate: ag('g-newest-off'), processName: FLOW, enabled: 0, ...WIN },
  { idOff: 71, operator: op('scope-nofb'), surrogate: ag('g-old2'), processName: FLOW, enabled: 1, ...WIN },
  { idOff: 73, operator: op('scope-nofb'), surrogate: ag('g-global'), processName: '', enabled: 1, ...WIN },

  // ── h1：兜底（全流程）作用域内同样"最新一条裁决、不回落更旧" ──
  { idOff: 74, operator: op('gscope-stale'), surrogate: ag('h-old1'), processName: '', enabled: 1, ...WIN },
  { idOff: 76, operator: op('gscope-stale'), surrogate: ag('h-newest-off'), processName: '', enabled: 0, ...WIN },
  { idOff: 75, operator: op('gscope-stale'), surrogate: ag('h-old2'), processName: null, enabled: 1, ...WIN },

  // ── B/J：正向对照（判据写反成"恒不命中"时这两组立刻红）──
  { idOff: 77, operator: op('only-effective'), surrogate: ag('p-agent'), processName: FLOW, enabled: 1, ...WIN },
  { idOff: 78, operator: op('newest-ok'), surrogate: ag('k-disabled'), processName: FLOW, enabled: 0, ...WIN },
  { idOff: 80, operator: op('newest-ok'), surrogate: ag('k-newest'), processName: FLOW, enabled: 1, ...WIN },
  { idOff: 79, operator: op('newest-ok'), surrogate: ag('k-expired'), processName: FLOW, enabled: 1, startOffDays: -5, endOffDays: -3 },

  // ── 不串人：别人的委托不得命中当前授权人（e2 负向 + e3 正向对照）──
  { idOff: 90, operator: op('someone-else'), surrogate: ag('o-agent'), processName: FLOW, enabled: 1, ...WIN },
]

/** 共用期望表（'' = 期望不命中）。两侧对拍 + 独立重算都吃这份，不各造一份 */
export const PARITY_CASES: ParityCase[] = [
  { what: 'p1 多条精确命中取 id 最大（插入序 +2→+3→+1：期望行非首条、非末条）',
    operator: op('zs'), processName: FLOW, want: ag('ex-max') },
  { what: 'p2 未精确命中 → 全流程兜底（id 更大的非空 processName 行不得充当兜底）',
    operator: op('zs'), processName: 'nomatch116', want: ag('all-flow') },
  { what: 'p3 查询传空流程名 = 只走兜底分支（不得拿大 id 精确行作答）',
    operator: op('zs'), processName: '', want: ag('all-flow') },
  { what: 'p4 兜底分支多条命中同样取 id 最大（期望行 processName 为 NULL，兜底不得只判 = \'\'' +
    '）', operator: op('zs2'), processName: FLOW, want: ag('all2-max') },
  { what: 'p5 委托给同名用户 ≠ 自委托（zs → n116p-namesake 应生效）',
    operator: op('zs'), processName: ag('namesake'), want: ag('namesake') },

  { what: 'q1 单条窗口已过期 ⇒ 不命中', operator: op('solo-expired'), processName: FLOW, want: '' },
  { what: 'q2 单条窗口未到 ⇒ 不命中', operator: op('solo-future'), processName: FLOW, want: '' },
  { what: 'q2b 同数据按未来时刻查询 ⇒ 命中（证明"未到窗"是真判据、不是恒不命中）',
    operator: op('solo-future'), processName: FLOW, queryOffDays: 4, want: ag('agent') },
  { what: 'q3 单条 start 有值 / end NULL = 该侧不限 ⇒ 命中',
    operator: op('solo-halfopen'), processName: FLOW, want: ag('agent') },
  { what: 'q4 单条双侧 NULL = 不限 ⇒ 命中', operator: op('solo-nowindow'), processName: FLOW, want: ag('agent') },
  { what: 'q5 单条 enabled=0 ⇒ 不命中', operator: op('solo-disabled'), processName: FLOW, want: '' },
  { what: 'q6 单条 enabled=2 脏值 ⇒ 不命中（只认 1）', operator: op('solo-dirty'), processName: FLOW, want: '' },
  { what: 'q7 单条代理人为空 ⇒ 不命中', operator: op('solo-empty'), processName: FLOW, want: '' },
  { what: 'q8 精确路径自委托 ⇒ 不命中', operator: op('solo-self-exact'), processName: FLOW, want: '' },
  { what: 'q9 兜底路径自委托（含 NULL processName）⇒ 不命中',
    operator: op('solo-self-all'), processName: 'any116', want: '' },

  // issues/123 任务 A：同作用域里"更旧的生效行"不得替最新那条说话
  { what: 'st1 最新一条窗外 ⇒ 不命中、不回落到更旧生效行（issues/123）',
    operator: op('st-window'), processName: FLOW, want: '' },
  { what: 'st1b 同数据按 +2 天查询 ⇒ 那条未来窗口记录成为最新命中行',
    operator: op('st-window'), processName: FLOW, queryOffDays: 2, want: ag('w-newest') },
  { what: 'st2 最新一条 enabled=0 ⇒ 不命中、不回落（issues/123）',
    operator: op('st-disabled'), processName: FLOW, want: '' },
  { what: 'st3 最新一条 enabled=2 脏值 ⇒ 不命中、不回落（issues/123）',
    operator: op('st-dirty'), processName: FLOW, want: '' },
  { what: 'st4 最新一条自委托 ⇒ 不命中、不回落（issues/123）',
    operator: op('st-self'), processName: FLOW, want: '' },
  { what: 'st5 最新一条代理人为空 ⇒ 不命中、不回落（issues/123）',
    operator: op('st-empty'), processName: FLOW, want: '' },
  { what: 'g1 精确作用域最新一条停用 ⇒ 由生效的全流程兜底行接管（issues/123 条款 1.4 后半句）',
    operator: op('scope-nofb'), processName: FLOW, want: ag('g-global') },
  { what: 'h1 兜底作用域最新一条停用 ⇒ 不命中、不回落到更旧兜底行（issues/123）',
    operator: op('gscope-stale'), processName: 'nomatch116', want: '' },

  // issues/123 任务 B：正向对照
  { what: 'B1 正向：作用域内只有一条窗内 enabled=1 ⇒ 命中',
    operator: op('only-effective'), processName: FLOW, want: ag('p-agent') },
  { what: 'J1 正向：最新一条生效、更旧两条不生效 ⇒ 命中最新那条',
    operator: op('newest-ok'), processName: FLOW, want: ag('k-newest') },

  { what: 'e1 无该授权人记录 → null', operator: op('nobody'), processName: FLOW, want: '' },
  { what: 'e2 他人委托在其自身流程上不命中他流程', operator: op('someone-else'), processName: OTHER_FLOW, want: '' },
  { what: 'e3 正向对照：他人自己的委托生效（钉住 e2 不是因"根本没数据"空转）',
    operator: op('someone-else'), processName: FLOW, want: ag('o-agent') },
]

/** 结构型接口：MemoryExtRepository / JdbcProcessExtRepository 都天然满足 */
export interface SurrogateQueryRepo {
  saveSurrogate(s: ProcessSurrogate): Promise<void>
  findSurrogateById(id: string): Promise<ProcessSurrogate | null>
  getSurrogate(operator: string, processName: string, at?: Date): Promise<ProcessSurrogate | null>
}

/** 查询时刻：now + queryOffDays 天（缺省 = now） */
export function parityAt(now: number, c: ParityCase): Date {
  return new Date(now + (c.queryOffDays ?? 0) * DAY)
}

/** 单行四判据的**独立**重算（不与被测仓储共用代码）：偏移直接比，at 用天偏移 */
function rowEffective(r: ParityRow, atOffDays: number): boolean {
  if (r.enabled !== 1) return false
  const agent = String(r.surrogate ?? '').trim()
  if (agent === '' || agent === r.operator) return false
  if (r.startOffDays !== undefined && r.startOffDays > atOffDays) return false
  if (r.endOffDays !== undefined && r.endOffDays < atOffDays) return false
  return true
}

/** 裁决池：先看精确作用域，池空才看全流程作用域（**不看生效判据**）。
 *  注意这只是「插入序判别力」检查用的池；真正的参考答案见 adjudicate()。 */
function scopePool(rows: ParityRow[], c: ParityCase): ParityRow[] {
  const mine = rows.filter(r => r.operator === c.operator)
  if (c.processName) {
    const exact = mine.filter(r => r.processName === c.processName)
    if (exact.length) return exact
  }
  return mine.filter(r => !r.processName)
}

/** 参考答案模型（独立重算，不与被测仓储共用代码）：精确作用域取 id 最新一条交四判据裁决；
 *  判否（含池空）后转看全流程作用域的最新一条。两层都判否才算未命中（条款 1.4 前后半句）。 */
function adjudicate(rows: ParityRow[], c: ParityCase, atOffDays: number): { surrogate: string; fromGlobal: boolean } {
  const newestOf = (pool: ParityRow[]) =>
    (pool.length ? pool.reduce((a, b) => (a.idOff >= b.idOff ? a : b)) : null)
  if (c.processName) {
    const e = newestOf(rows.filter(r => r.operator === c.operator && r.processName === c.processName))
    if (e && rowEffective(e, atOffDays)) return { surrogate: e.surrogate, fromGlobal: false }
  }
  const g = newestOf(rows.filter(r => r.operator === c.operator && !r.processName))
  if (g && rowEffective(g, atOffDays)) return { surrogate: g.surrogate, fromGlobal: true }
  return { surrogate: '', fromGlobal: false }
}

/**
 * 判别力自证：**独立重算**「取最新一条 → 四判据裁决这一条」（不复用被测仓储实现），核对
 * ①期望表与数据集自洽；②多命中组（≥2 条同作用域）的裁决行落在插入序**中间**；
 * ③负向组若"另有更旧的生效行"，同样要求裁决行既非首条也非末条（否则"取插入末条"跟着绿）；
 * ④四类判别力至少各覆盖一次：正向 / 多条命中取最大 / 同作用域不回落更旧 / 精确判否后兜底命中。
 * 返回问题列表（空 = 夹具合格），两侧都先跑它。
 */
export function verifyParityFixtures(): string[] {
  const problems: string[] = []
  let positive = 0, multiHit = 0, noOlderFallback = 0, scopeFallbackHit = 0
  for (const c of PARITY_CASES) {
    const at = c.queryOffDays ?? 0
    const pool = scopePool(PARITY_ROWS, c)
    const got = pool.length ? pool.reduce((a, b) => (a.idOff >= b.idOff ? a : b)) : null
    const judged = adjudicate(PARITY_ROWS, c, at)
    const answer = judged.surrogate
    if (answer !== c.want) {
      problems.push(`${c.what}：按「先取该作用域 id 最新一条裁决、精确判否再兜底全流程」应为 ${JSON.stringify(answer)}` +
        `，期望表却写了 ${JSON.stringify(c.want)}——期望与数据集不自洽（issues/123）`)
      continue
    }
    if (judged.fromGlobal && c.want !== '') scopeFallbackHit++ // 精确判否 ⇒ 由全流程兜底命中（条款 1.4 后半句）
    if (c.want !== '') {
      positive++
      if (pool.length >= 2) {
        multiHit++
        const idx = pool.findIndex(r => got && r.idOff === got.idOff)
        if (idx === 0 || idx === pool.length - 1) {
          problems.push(`夹具失去判别力：${c.what} 有 ${pool.length} 条同作用域记录（插入序 id_off ${pool.map(r => r.idOff)}），` +
            `裁决那条落在第 ${idx + 1} 位（首位/末位）——「取遍历首条」「取插入末条」的错实现会跟着一起绿`)
        }
      }
      continue
    }
    // 负向期望：池内若另有"更旧的生效行"，本条才算真在测 issues/123 的"不得回落到更旧那条"
    const olderEffective = !!got && pool.some(r => r !== got && r.idOff < got.idOff && rowEffective(r, at))
    if (olderEffective) {
      noOlderFallback++
      const idx = pool.findIndex(r => got && r.idOff === got.idOff)
      if (idx === 0 || idx === pool.length - 1) {
        problems.push(`夹具失去判别力：${c.what} 的裁决行(id_off=${got?.idOff})落在插入序第 ${idx + 1} 位，` +
          `而池内另有更旧的生效行——「取插入末条」的错实现会因末条恰是裁决行而跟着夹具一起绿。` +
          `须把生效行补到首末两位`)
      }
    }
  }
  if (positive === 0) problems.push('夹具自证：没有任何正向判据——判据若被写反成「恒不命中」不会被发现（issues/123 任务 B）')
  if (multiHit === 0) problems.push('夹具自证：没有任何一个判据存在 ≥2 条同作用域记录——条款 1.4「多条命中取 id 最大」根本没被对拍到')
  if (noOlderFallback === 0) problems.push('夹具自证：没有任何一条「最新一条不生效 + 同作用域另有更旧生效行」的判据——issues/123 的核心「不得回落到更旧那条」根本没被对拍到')
  if (scopeFallbackHit === 0) problems.push('夹具自证：没有任何一条「精确作用域最新一条判否 ⇒ 由全流程作用域兜底命中」的判据——条款 1.4 的后半句根本没被对拍到')
  return problems
}

/** Row → ProcessSurrogate（显式 string id；两侧共用同一映射，唯一差异是 baseId） */
export function toParitySurrogate(r: ParityRow, baseId: number, now: number): ProcessSurrogate {
  const ts = new Date(now)
  return {
    id: String(baseId + r.idOff),
    processName: r.processName ?? undefined,
    operator: r.operator,
    surrogate: r.surrogate,
    enabled: r.enabled as any,
    startTime: r.startOffDays === undefined ? undefined as any : new Date(now + r.startOffDays * DAY),
    endTime: r.endOffDays === undefined ? undefined as any : new Date(now + r.endOffDays * DAY),
    createTime: ts, createUser: 'n116p', updateTime: ts, updateUser: 'n116p',
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
  report('夹具自证：期望表与数据自洽（先取最新再裁决），且裁决行落在插入序中间（打乱 id 序真起判别力）',
    problems.length === 0, problems.join('；'))

  // 落库与查询用同一个时间基准（夹具窗口是相对 now 的天偏移，量级 ±1 天，
  // 两次取 Date.now() 的毫秒差不会翻转任何判据）
  const now = Date.now()
  const ids: string[] = []
  for (const r of PARITY_ROWS) {
    await ext.saveSurrogate(toParitySurrogate(r, baseId, now))
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
    const hit = await ext.getSurrogate(c.operator, c.processName, parityAt(now, c))
    const got = hit?.surrogate ?? ''
    report(c.what, got === c.want, `want=${JSON.stringify(c.want)} got=${JSON.stringify(got)}`)
  }
  return ids
}
