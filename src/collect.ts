/**
 * 动态会签（征询模式 `dynamicCountersign`，issues/247）——成员行识别、闸门计数、投影、
 * 轮次与追加式账本＋解析期禁配（Node 栈）。
 *
 * 判据出处：规范 02 §4.4（开关与三条解析期硬校验）＋规范 04「动态会签（征询模式）」整节
 * （提交分流／成员行建单规则／撤回接口／语义边界）＋规范 06 §2.7（协议键与投影）与
 * §processTask/revokeDynamicCountersign。本能力不新增节点类型、不新增 submitType 档、无 DDL
 * （成员行即普通任务行）、不新增事件码（成员行建/结走既有码 3/5）、成员意见无表决语义。
 *
 * 形状基准＝jeeflow-java `core/CollectSupport.java`（参考实现 ffe2749 的纯函数家族；
 * 分流/闸门/撤回三条腿在 `facade/JeeflowFacade`，征询档推进闸在 `model/TaskModel.exec` 第三档），
 * `jeeflow-go/engine/collect.go`＋`facade/collect.go`（v1.8.61）与
 * `jeeflow-python/jeeflow/collect.py`＋`facade.py`（1.8.57）是同一条移植腿的两份交叉样本。
 *
 * 语义一句话：主办提交带 `tf_addSignOperators` 时**不办结主办行**，按人建成员行收意见；
 * 全部成员提交后闸门打开，主办再按普通办理（同意/不同意）决定走向。与后加签的本质差异：
 * 后加签主办在拉人时即办结、接力自动推进；征询模式主办挂起、**拍板权始终在主办**。
 *
 * # 成员行识别（java 实测踩过的坑，别简化）
 *
 * 成员行＝parent 指向主办行**且同节点同名**的行（成员不能再拉人 ⇒ 无更深层级）。
 * **同名过滤不可省**：主办办结推进后，下一节点行的 parent 同样是主办行 id（建单不变量），
 * 只认 parent 会把下游行误当成员——撤回腿会误废弃它们（go 测试实抓过这一格）。
 *
 * <p>本模块与 `addsign.ts` 互为引用（本文件取 `parseAllow`／`allowAddSignOf`／`historyOf`／
 * `KeyAddSignHistory` 四枚既有单点，`addsign.ts` 的 `checkFlowConfig` 与废弃腿反向取本文件的
 * 开关判据），形状与本仓既有的 `engine.ts ↔ addsign.ts` 同族：跨模块符号一律只在**函数体内**
 * 取用，求值期不碰。</p>
 */
import { isFirstTaskName, isCountersign } from './engine.js'
import { parseAllow, allowAddSignOf, historyOf, KeyAddSignHistory, formatAddSignTime } from './addsign.js'
import { type FlowModel, type FlowNode, type ProcessTask, TaskState, TypeTask } from './model.js'

/** 节点属性键：动态会签（征询模式）开关（`properties` 平铺层，缺省 false） */
export const PROP_DYNAMIC_COUNTERSIGN = 'dynamicCountersign'
/**
 * 协议键（选填，字符串）：发起该轮会签的原因说明，随账本条目落库并盖到每条成员行
 * （单行出证自足，不回查主办行）；选填不写键。与后加签共用 `tf_addSignOperators`，
 * reason 这一枚是征询模式自己的（规范 06 §2.7）。
 */
export const KeyAddSignReason = 'tf_addSignReason'

// ─── 逐字判据文案（跨栈统一；规范 06 文末失败文案表） ──────────────────────────

export const msgPending = (taskName: string, submitted: number, total: number): string =>
  `节点[${taskName}]动态会签意见未收齐（已提交 ${submitted}/${total}），不能办理`
export const msgDuplicate = (actor: string, nodeName: string): string =>
  `操作人[${actor}]已在节点[${nodeName}]的动态会签中`
export const MSG_MEMBER_PULL = '动态会签成员任务不能发起加签'
export const msgNoPending = (nodeName: string): string =>
  `节点[${nodeName}]没有进行中的动态会签`
export const MSG_NO_PERMISSION_REVOKE = '无权限撤回该动态会签'
/**
 * 「操作人不是主办行参与人」那一档的对外 msg＝java `WfErrEnum.NOT_ALLOWED_EXECUTE`（20010004）
 * 逐字文案（go/py 两腿同取这一句，码不进文案）。⚠️ 本栈引擎 `loadAndCheck` 那条同语义的既有
 * 腿历史上出的是英文串（`operator X not allowed`），本轮不改动它（改面超出 246/247），
 * 征询分流腿按基准出逐字中文——两档差异已记进对齐报告。
 */
export const MSG_NOT_ALLOWED_EXECUTE = '当前参与者不能执行该流程任务'

// ─── 解析期硬校验文案（规范 02 §4.4，三条禁配逐字） ────────────────────────────

export const msgMutexWithAddSign = (nodeName: string): string =>
  `节点[${nodeName}]不允许同时配置 allowAddSign 与 ${PROP_DYNAMIC_COUNTERSIGN}：` +
  '两档共用 tf_addSignOperators，行为靠节点属性分流，双开＝行为歧义'
export const msgCollectCountersignForbid = (nodeName: string): string =>
  `会签节点[${nodeName}]不允许配置 ${PROP_DYNAMIC_COUNTERSIGN}：会签池推进语义与征询挂起语义打架`
export const msgCollectApplyForbid = (nodeName: string): string =>
  `申请节点[${nodeName}]不允许配置 ${PROP_DYNAMIC_COUNTERSIGN}：` +
  '申请节点那手走实例撤回＋重新发起，不需要征询挂起'

// ─── 节点开关解析 ─────────────────────────────────────────────────────────────

/**
 * 读某节点的 `dynamicCountersign`：非任务节点一律 false（java 判 `node instanceof TaskModel`），
 * 任务节点走 `addsign.parseAllow` 那一枚共用解析器（缺省 false；非法值抛配置错误）。
 * 执行闸（征询档推进闸）、门面分流/闸门/撤回三条腿都用这一枚判"是不是征询节点"。
 */
export function dynamicCountersignOf(node: FlowNode | undefined): boolean {
  return !!node && node.type === TypeTask &&
    parseAllow(node.properties?.[PROP_DYNAMIC_COUNTERSIGN], node.id, PROP_DYNAMIC_COUNTERSIGN)
}

/**
 * 解析期三条硬校验（规范 02 §4.4）＋本开关自身的值合法性，两批判据**按此顺序**跑：
 * ① 每个任务节点的 `dynamicCountersign` 值合法性（非法值当场抛，不静默落回缺省）；
 * ② 三条禁配（位序照 java `ModelParser.parse` 尾部那一段）：与 `allowAddSign` 双开
 *    （两模式共用 `tf_addSignOperators`，行为靠节点属性分流，双开＝行为歧义）、
 *    会签节点禁配（会签池推进语义与征询挂起语义打架）、申请节点（start 直接后继）禁配
 *    （申请节点那手走实例撤回＋重新发起，不需要征询挂起）。
 * 落点＝`addsign.checkFlowConfig`（三段校验共用那一个入口，与 java 的 ModelParser 同位）。
 */
export function checkCollectFlowConfig(flow: FlowModel): void {
  const tasks = (flow?.nodes ?? []).filter(n => n.type === TypeTask)
  for (const n of tasks) {
    parseAllow(n.properties?.[PROP_DYNAMIC_COUNTERSIGN], n.id, PROP_DYNAMIC_COUNTERSIGN)
  }
  for (const n of tasks) {
    if (!dynamicCountersignOf(n)) continue
    if (allowAddSignOf(n)) throw new Error(msgMutexWithAddSign(n.id))
    if (isCountersign(n.properties?.performType)) throw new Error(msgCollectCountersignForbid(n.id))
    if (isFirstTaskName(flow, n.id)) throw new Error(msgCollectApplyForbid(n.id))
  }
}

// ─── 成员行识别（纯函数） ─────────────────────────────────────────────────────

/**
 * 成员行＝parent 指向主办行**且同节点同名**的行（成员不能再拉人 ⇒ 无更深层级）。
 * 同名过滤不可省，理由见文件头「成员行识别」段。
 */
export function memberRows(tasks: ProcessTask[], host: ProcessTask | null | undefined): ProcessTask[] {
  const out: ProcessTask[] = []
  if (!host || !host.id) return out
  for (const t of tasks ?? []) {
    if (t.parentTaskId === host.id && t.taskName === host.taskName) out.push(t)
  }
  return out
}

/**
 * 成员行判定：parent 指向**同节点同名**行（成员行禁带拉人参数的判据）。
 * 无 parent（空／'0'）的行一律 false——普通建单那条不是成员。
 */
export function isMemberRow(tasks: ProcessTask[], row: ProcessTask | null | undefined): boolean {
  if (!row || !row.parentTaskId || row.parentTaskId === '0') return false
  for (const t of tasks ?? []) {
    if (t.id === row.parentTaskId && t.taskName === row.taskName) return true
  }
  return false
}

/** 未答成员行（DOING）：闸门判据的原料，也是撤回接口的废弃集合。 */
export function pendingMembers(tasks: ProcessTask[], host: ProcessTask): ProcessTask[] {
  return memberRows(tasks, host).filter(t => t.isDoing())
}

/**
 * 闸门原料：在册成员行总数与已提交（FINISHED）数——**已废弃(99) 行（撤回腿清场的）不算在册**；
 * 空集＝本行不是征询主办行。返回 `[total, submitted]`。
 */
export function memberCounts(tasks: ProcessTask[], host: ProcessTask): [number, number] {
  let total = 0
  let submitted = 0
  for (const t of memberRows(tasks, host)) {
    if (t.taskState === TaskState.Abandoned) continue
    total++
    if (t.isFinished()) submitted++
  }
  return [total, submitted]
}

/**
 * 投影（规范 06 §2.7）：征询主办行 `ext.dynamicCountersign`
 * ＝`{active, round, total, submitted, actors:[{actor, taskId, state}]}`；无成员行 ⇒ null
 * （门面那侧"不写键"）。从成员行**现算**、不落新存储，跳过 99 废弃行（撤回清场的行不进投影）。
 */
export function buildProjection(tasks: ProcessTask[], host: ProcessTask): Record<string, any> | null {
  const members = memberRows(tasks, host)
  if (members.length === 0) return null
  let total = 0
  let submitted = 0
  const actors: Record<string, any>[] = []
  for (const m of members) {
    if (m.taskState === TaskState.Abandoned) continue
    total++
    if (m.isFinished()) submitted++
    actors.push({
      actor: m.actorIds && m.actorIds.length > 0 ? m.actorIds[0] : null,
      taskId: m.id,
      state: m.taskState,
    })
  }
  return {
    active: submitted < total,
    round: lastRound(host),
    total,
    submitted,
    actors,
  }
}

// ─── 轮次与账本 ───────────────────────────────────────────────────────────────

/**
 * 主办行当前轮次＝账本条数的末条 `round`（每次拉人追加一条＝轮次推进；**撤回不消耗轮次**）。
 * 读的是主办行自己的 `tf_addSignHistory` 末条（`addsign.historyOf` 那一枚读法），与后加签
 * `roundOf` 读成员行轮次戳的写法对称。
 */
export function lastRound(host: ProcessTask | null | undefined): number {
  const history = historyOf(host)
  if (history.length === 0) return 0
  const last = history[history.length - 1]
  const r = Number(last?.round)
  return Number.isFinite(r) ? r : 0
}

/**
 * 发起会签账本追加（只追加不覆盖），落**主办行**（征询模式下主办行未办结，
 * 行变量随行活到办结后）；每条含 `reason`（选填，空串不写键）。
 * ⚠️ 调用方随后必须把主办行再落一次库（快照仓储纪律，同 `addsign.appendHistory`）。
 */
export function appendCollectHistory(host: ProcessTask, operator: string, toActors: string[],
                                      round: number, reason: string, now: Date): void {
  const entry = baseEntry(operator, toActors, round, now)
  if (reason !== '') entry.reason = reason
  append(host, entry)
}

/**
 * 撤回会签账本追加：`revoked: true` 标记本条是撤回（未答废弃），`toActors`＝被撤的人；
 * 轮次不消耗（本条不推进轮次，`round` 记当轮）。
 */
export function appendRevokeHistory(host: ProcessTask, operator: string, revokedActors: (string | null)[],
                                     round: number, reason: string, now: Date): void {
  const entry = baseEntry(operator, [], round, now)
  entry.toActors = [...revokedActors]
  entry.revoked = true
  if (reason !== '') entry.reason = reason
  append(host, entry)
}

/** 账本条目五键固定 camelCase（`round, fromActor, toActors, time, operator`），照 `tf_addSignHistory` 既有条目。 */
function baseEntry(operator: string, toActors: string[], round: number, now: Date): Record<string, any> {
  return {
    round,
    fromActor: operator,
    toActors: [...toActors],
    time: formatAddSignTime(now),
    operator,
  }
}

function append(host: ProcessTask | null | undefined, entry: Record<string, any>): void {
  if (!host) return
  const vars = host.variables
  if (!vars) return
  const history: Record<string, any>[] = Array.isArray(vars[KeyAddSignHistory])
    ? [...(vars[KeyAddSignHistory] as Record<string, any>[])]
    : []
  history.push(entry)
  vars[KeyAddSignHistory] = history
}
