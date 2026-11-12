/**
 * 后加签（可重复）——节点开关解析、写入口校验、轮次与追加式账本（Node 栈）。
 *
 * 判据出处：规范 04「后加签（可重复）」＋门面契约 06 §2.7；形状基准＝jeeflow-java
 * `core/AddSignSupport.java`（参考实现），逐字文案与四判据顺序同尺。
 *
 * <p><b>为什么校验一律排在改动状态之前</b>：内存仓储没有事务回滚，一旦先 `completeTask`
 * 再判错，那条任务行就在聚合里变成已完成而无人能改回来——"报错且无写入"是这条链的硬要求，
 * 所以 {@link validateSubmission} 由引擎在 `prepareExecuteTask` 里、完成任务之前调用，
 * 不放进建单腿。</p>
 *
 * <p>本模块只读 {@link './engine.js'} 的两个既有单点（`tf_nextNodeOperator` 键名、参与者归一
 * 那枚 `parseActorIds`），不复制第二份判据；`engine.ts ↔ addsign.ts` 的相互引用与本仓
 * `engine.ts ↔ reapply.ts` 同形（常量在函数体内取用，求值期不碰）。</p>
 */
import { KeyNextNodeOperator, parseActorIds, isFirstTaskName, isCountersign } from './engine.js'
import { normalizeActorValue, normalizeActors } from './spi.js'
import { type FlowModel, type FlowNode, type ProcessInstance, type ProcessTask, TypeTask } from './model.js'
// issues/246／247 两开关的解析期校验与废弃腿双判据。这三行与本文件顶部 `engine.js` 那行同族
// （引擎↔支持层互指，求值期不碰）：`recall.ts`／`collect.ts` 反过来只 import 本文件的
// `parseAllow`／`historyOf`／`KeyAddSignHistory` 等**函数与常量**，且一律在函数体内取用 ⇒
// ESM 环里没有任何"求值期解引用"，模块实例化顺序怎么排都不撞 TDZ。
import { checkRecallFlowConfig } from './recall.js'
import { checkCollectFlowConfig, dynamicCountersignOf } from './collect.js'

/** 节点属性键：后加签开关（`properties` 平铺层，缺省 false） */
export const PROP_ALLOW_ADD_SIGN = 'allowAddSign'
/** 节点属性键：加签轮次上限（0＝不限，缺省 0） */
export const PROP_ADD_SIGN_MAX_ROUNDS = 'addSignMaxRounds'
/** 本次提交指定的**本节点**后继办理人（规范 06 §2.7） */
export const KeyAddSignOperators = 'tf_addSignOperators'
/** 追加式账本（落已完成任务行变量，形状照 `tf_transferHistory`） */
export const KeyAddSignHistory = 'tf_addSignHistory'
/**
 * 轮次号键前缀（拼 `_{节点ID}`）。不复用会签的 `loopCounter`：后者是退回复活时被
 * `lineageVars` 剔掉的会签簿记，加签链的轮次要跨"已办过的人"计数。
 */
export const AddSignRoundKey = 'addSignRound'

// ─── 逐字判据文案（跨栈统一；规范 06 文末失败 msg 表） ──────────────────────────

export const MSG_MUTEX = 'tf_addSignOperators 与 tf_nextNodeOperator 互斥，不能同时提交'
export const msgSwitchOff = (nodeName: string): string =>
  `节点[${nodeName}]未开启 allowAddSign，不接受 tf_addSignOperators`
export const MSG_SELF = '不能把任务加签给自己'
export const msgMaxRounds = (nodeName: string, max: number): string =>
  `节点[${nodeName}]的加签轮次已达上限 ${max}，本次提交被拒绝`
const msgAllowIllegal = (nodeName: string, keyName: string, v: string): string =>
  `节点[${nodeName}]的 ${keyName} 配置非法: ${v}`
const msgMaxRoundsNotInt = (nodeName: string, v: string): string =>
  `节点[${nodeName}]的 ${PROP_ADD_SIGN_MAX_ROUNDS} 配置非法: ${v}（必须是整数）`
const msgMaxRoundsNotInt0 = (nodeName: string, v: string): string =>
  `节点[${nodeName}]的 ${PROP_ADD_SIGN_MAX_ROUNDS} 配置非法: ${v}（必须是整数，0 表示不限）`
const msgMaxRoundsNegative = (nodeName: string, v: string | number): string =>
  `节点[${nodeName}]的 ${PROP_ADD_SIGN_MAX_ROUNDS} 配置非法: ${v}（不得为负，0 表示不限）`

/** 全生态时间格式（规范 §2.4），与 `tf_transferHistory` 同尺：`yyyy-MM-dd HH:mm:ss` */
export function formatAddSignTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// ─── 节点开关解析（非法值报配置错误，不得静默当缺省——照 reapplyMode 先例） ───────

/**
 * 解析布尔开关：缺省 false；非布尔报配置错误，不得静默当缺省。
 *
 * `keyName`＝报错文案里的属性键名（java `AddSignSupport.parseAllow` 的第三参同位）。缺省回落在
 * 本开关自己的键 `allowAddSign`；issues/246/247 的 `allowRecall`／`dynamicCountersign` 走
 * **同一枚**解析器（`recall.ts`／`collect.ts` 传各自键名），文案键位逐字不串、不留第二份判据。
 */
export function parseAllow(value: unknown, nodeName: string, keyName: string = PROP_ALLOW_ADD_SIGN): boolean {
  if (value == null) return false
  if (typeof value === 'boolean') return value
  const v = String(value).trim()
  if (v === '') return false
  const lower = v.toLowerCase()
  if (lower === 'true') return true
  if (lower === 'false') return false
  throw new Error(msgAllowIllegal(nodeName, keyName, v))
}

/** 解析 `addSignMaxRounds`：缺省 0＝不限；非整数或负数报解析期错误。 */
export function parseMaxRounds(value: unknown, nodeName: string): number {
  if (value == null) return 0
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(msgMaxRoundsNotInt(nodeName, String(value)))
    if (value < 0) throw new Error(msgMaxRoundsNegative(nodeName, value))
    return value
  }
  const v = String(value).trim()
  if (v === '') return 0
  // 整数判据与 java `Integer.parseInt` 同档：收 +/-，拒小数与别的样子
  if (!/^[+-]?\d+$/.test(v) || !Number.isSafeInteger(Number(v))) {
    throw new Error(msgMaxRoundsNotInt0(nodeName, v))
  }
  const n = Number(v)
  if (n < 0) throw new Error(msgMaxRoundsNegative(nodeName, v))
  return n
}

/** 读某节点开关（节点属性已在本文件 {@link checkFlowConfig} 的解析期校验里判过合法性）。 */
export function allowAddSignOf(node: FlowNode | undefined): boolean {
  return !!node && parseAllow(node.properties?.[PROP_ALLOW_ADD_SIGN], node.id)
}

/** 读某节点轮次上限。 */
export function maxRoundsOf(node: FlowNode | undefined): number {
  return node ? parseMaxRounds(node.properties?.[PROP_ADD_SIGN_MAX_ROUNDS], node.id) : 0
}

/**
 * 节点级 taskType 协办档判定（规范 02 §4.4，issues/252）：本栈建单恒落 taskType=0、
 * 没有 java 那枚 taskType codeOf 容错表，判定照 isCountersign 同尺（String＋trim＋toUpperCase，
 * 大小写不敏感）：1／"1"／"协办"／"SECONDARY" ⇒ 协办；其余值维持既有静默回落主办
 * （issues/245 口径，不扩成 fail-fast）。
 */
export function isSecondaryTaskType(v: unknown): boolean {
  const s = String(v ?? '').trim().toUpperCase()
  return s === '1' || s === 'SECONDARY' || s === '协办'
}

/**
 * 解析期硬校验（规范 02 §4.3／§4.4）——本栈没有 java 那一层 `ModelParser`（`JSON.parse(content)`
 * 直接当 FlowModel 用），故落点＝引擎每次读定义的解析口（`engine.ts` 的 `loadFlowModel`）＋
 * 门面的三条发布腿。配了就直接报错，不做运行时降级：静默跑下去会让配置者以为开关生效，
 * 实际两档推进闸各裁各的。
 *
 * <p>位序照 java `ModelParser.parse` 尾部三段：**后加签两判 → 已办撤回两判 → 动态会签三判**
 * （90469a2／ffe2749）。后两段的本体在 `recall.ts`／`collect.ts`（各自的开关与禁配各自守），
 * 本函数是三段共用的那一个入口——与 java 一样"读一次定义只校一次"，不留第二个调用面。</p>
 *
 * <p>本段四条：⓪ 节点级 `taskType=1`（协办）禁配（issues/252，先于开关解析——java 同判据
 * 在 TaskParser 读 taskType 处）；① 两键非法值；② 会签节点配 `allowAddSign`；③ 首任务节点配
 * `allowAddSign`。</p>
 */
export function checkFlowConfig(flow: FlowModel): void {
  const tasks = (flow?.nodes ?? []).filter(n => n.type === TypeTask)
  // ① 键的合法性：每个任务节点都判（与 java TaskParser 逐节点解析同档），不是只判开了开关的
  for (const n of tasks) {
    // 节点级协办禁配（规范 02 §4.4，issues/252）：协办档只由运行期 processTask/aidant 派生
    // （issues/253），snaker 原义下协办节点办结不驱动且跳转同闸，节点级配了就是流程悬挂陷阱。
    if (isSecondaryTaskType(n.properties?.taskType)) {
      throw new Error(`节点[${n.id}]不允许配置协办任务类型（taskType=1）`)
    }
    parseAllow(n.properties?.[PROP_ALLOW_ADD_SIGN], n.id)
    parseMaxRounds(n.properties?.[PROP_ADD_SIGN_MAX_ROUNDS], n.id)
  }
  // ②③ 排在合法性之后：这两条要沿 start 的出边看拓扑
  for (const n of tasks) {
    if (!allowAddSignOf(n)) continue
    if (isCountersign(n.properties?.performType)) {
      throw new Error(`会签节点[${n.id}]不允许配置 ${PROP_ALLOW_ADD_SIGN}：` +
        '会签池内加人与会签之后加人是两种语义，推进闸会打架')
    }
    if (isFirstTaskName(flow, n.id)) {
      throw new Error(`首任务节点[${n.id}]不允许配置 ${PROP_ALLOW_ADD_SIGN}：` +
        '申请节点的办理是发起/重提语义，与加签路由打架')
    }
  }
  // 已办撤回两判 ＋ 动态会签三判（规范 02 §4.4，issues/246／247）
  checkRecallFlowConfig(flow)
  checkCollectFlowConfig(flow)
}

// ─── 本次提交的加签人 ──────────────────────────────────────────────────────────

/**
 * 本次提交指定的加签人（逗号串与数组**两形同判据**，复用规范 06 §2.11 那枚归一单点：
 * 逐元素 trim、空串/纯空白/null 丢弃、丢完为空＝没传）。没点人返回空数组。
 */
export function operators(args: Record<string, any> | null | undefined): string[] {
  const raw = args?.[KeyAddSignOperators]
  if (raw == null) return []
  if (typeof raw === 'string' || Array.isArray(raw)) return parseActorIds(raw)
  // 标量档与 java `normalizeActorArg` 同判据（数字 0 是一个人，不是空值）
  return normalizeActors([raw])
}

/**
 * 本次提交是否同时给了 `tf_nextNodeOperator`（互斥判据的左半，**共用这一枚**：
 * 后加签写入口 `validateSubmission` 与动态会签发起分流 `facade.tryDynamicCountersign` 都读它）。
 * 「归一后为空＝没传」与 §2.11 同尺：数组里全是空元素、串全是空白，都不算占用那一档。
 */
export function nextOperatorPresent(args: Record<string, any> | null | undefined): boolean {
  if (!args) return false
  const nextRaw = args[KeyNextNodeOperator]
  if (nextRaw == null) return false
  return Array.isArray(nextRaw) || typeof nextRaw === 'string'
    ? parseActorIds(nextRaw).length > 0
    : normalizeActorValue(nextRaw) !== ''
}

/**
 * 写入口校验（互斥／开关未开／加给自己／超上限）。必须在改动任何状态之前调用。
 *
 * <p>互斥这一条的理由不是语义矛盾（一个管本节点再来一轮、一个管流出后交给谁，逻辑可共存），
 * 而是<b>参数生命周期</b>：`tf_*` 键只在当次请求的执行参数与已完成任务行变量里可读，
 * 加签使令牌停留本节点、流出发生在后续请求，届时先传的 `tf_nextNodeOperator` 已不可读
 * ——同传时它是死参数。静默择一＝用户选的"下一节点处理人"无声消失，报错是把它变响话。</p>
 */
export function validateSubmission(flow: FlowModel, task: ProcessTask, args: Record<string, any> | null | undefined,
                                    operator: string): void {
  if (!args || !task) return
  const ops = operators(args)
  if (ops.length > 0 && nextOperatorPresent(args)) throw new Error(MSG_MUTEX)
  if (ops.length === 0) {
    // 没点人＝正常流转档，其余判据不涉及（也不要求节点开开关）
    return
  }
  const node = (flow?.nodes ?? []).find(n => n.id === task.taskName)
  if (!node || node.type !== TypeTask || !allowAddSignOf(node)) {
    throw new Error(msgSwitchOff(task.taskName))
  }
  const me = normalizeActorValue(operator)
  if (me !== '' && ops.includes(me)) throw new Error(MSG_SELF)
  const max = maxRoundsOf(node)
  if (max > 0 && roundOf(task, task.taskName) + 1 > max) {
    throw new Error(msgMaxRounds(node.id, max))
  }
}

// ─── 推进闸与废弃 ──────────────────────────────────────────────────────────────

/** 本节点是否还有未完成任务（刚办结那条此刻已是 DONE，不计入）。 */
export function hasDoingOnNode(inst: ProcessInstance | null | undefined, nodeName: string): boolean {
  if (!inst || !nodeName) return false
  return (inst.tasks ?? []).some(t => t.taskName === nodeName && t.isDoing())
}

/**
 * 废弃本节点未完成的加签任务（拒绝／退回发起人时调用，不留孤儿待办）。
 * 只对开了 `allowAddSign` **或** `dynamicCountersign` 的节点动手（issues/247：征询成员行同属
 * 本节点 DOING，实例撤回／退回路径一并清场——废弃腿条件扩成双开关，java `AddSignSupport
 * .abandonDoingOnNode` 同判据）；会签节点的兄弟任务由既有会签腿管，不在此扩面。
 * 返回被废弃的行，由调用方落库（本栈的持久化腿在引擎侧，聚合根不写库）。
 */
export function abandonDoingOnNode(flow: FlowModel, inst: ProcessInstance, nodeName: string,
                                    now: Date): ProcessTask[] {
  if (!flow || !inst || !nodeName) return []
  const node = (flow.nodes ?? []).find(n => n.id === nodeName)
  if (!allowAddSignOf(node) && !dynamicCountersignOf(node)) return []
  const abandoned: ProcessTask[] = []
  for (const t of inst.tasks ?? []) {
    if (t.taskName === nodeName && t.isDoing()) {
      t.abandon(now)
      abandoned.push(t)
    }
  }
  return abandoned
}

/** 读轮次号：首圈（普通建单产生的那条）没有该键 ⇒ 0。 */
export function roundOf(task: ProcessTask | null | undefined, nodeName: string): number {
  const v = task?.variables?.[`${AddSignRoundKey}_${nodeName}`]
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * 账本追加（只追加不覆盖），落已完成任务行变量；`tf_` 前缀使退回复活腿（`lineageVars`）
 * 天然剔掉它 ⇒ 账本只留在已完成的历史行上、不污染新待办。
 * 五键固定 camelCase，顺序与 java 同（`round, fromActor, toActors, time, operator`）。
 */
export function appendHistory(completed: ProcessTask | null | undefined, operator: string,
                               toActors: string[], round: number, now: Date): void {
  if (!completed) return
  const vars = completed.variables
  if (!vars) return
  const existing = vars[KeyAddSignHistory]
  const history: Record<string, any>[] = Array.isArray(existing)
    ? [...(existing as Record<string, any>[])]
    : []
  history.push({
    round,
    fromActor: operator,
    toActors: [...toActors],
    time: formatAddSignTime(now),
    operator,
  })
  vars[KeyAddSignHistory] = history
}

/** 读账本（测试与投影用）。 */
export function historyOf(task: ProcessTask | null | undefined): Record<string, any>[] {
  const v = task?.variables?.[KeyAddSignHistory]
  return Array.isArray(v) ? (v as Record<string, any>[]) : []
}
