/**
 * 已办撤回（`allowRecall`，issues/246）——节点开关解析、窗口判据、追加式账本（Node 栈）。
 *
 * 判据出处：规范 02 §4.4（开关与两条解析期硬校验）＋规范 04「已办撤回」整节（宽口径窗口／
 * 动作三件／承诺边界）＋规范 06 §processTask/recall（判据位序与五条逐字失败文案）＋
 * 规范 11 码 10 `TASK_RECALL`。
 *
 * 形状基准＝jeeflow-java `core/RecallSupport.java`（参考实现 90469a2 的纯函数家族；
 * 判据位序＋落库序在 `core/JeeflowEngineImpl.recallTask`，复活三件在
 * `domain/ProcessInstance.recallTask`），`jeeflow-go/engine/recall.go`（v1.8.61）＋
 * `jeeflow-python/jeeflow/recall.py`（1.8.57）是同一条移植腿的两份交叉样本。
 *
 * <p>三条承重纪律（照 java 逐条对过）：</p>
 * 1. **判据全部排在任何状态变更之前**（报错即零写入）——内存仓储无回滚，先废弃再判错就会
 *    留下不可恢复的半撤状态；与后加签写入口／退回上一步守卫同一规矩。位序照 java：
 *    行存在且已办结 → 参与者/特权 → 实例 DOING → 节点开关 → 窗口。
 * 2. **参与人判断不走只认 DOING 的 `isAllowed`**——目标行是 FINISHED，按**名册**（`actorIds`）
 *    判断；`flow.auto`／`flow.admin` 特权放行（与转办同口径）。
 * 3. **原 FINISHED 行一律不改写**——jeeflow 无独立历史表，任务行即审批历史，翻回 DOING＝
 *    改写已出证记录；唯一追加痕迹是落在旧行变量上的 `tf_recallHistory` 追加账本
 *    （`tf_` 前缀使退回复活腿 `lineageVars` 天然剔掉它 ⇒ 不污染新待办）。
 *
 * 窗口取**宽口径**（owner 2026-11-03 拍）：从该行沿 `task_parent_id` 血缘产出的全部下游行中
 * **存在任何 FINISHED ⇒ 拦**；否则仍 DOING 的下游行全部废弃（后加签/征询成员行、并行分支
 * 多支自然覆盖；已废弃(99)/已撤回(30) 行既不拦也不重复废弃）。
 *
 * <p>本模块与 `addsign.ts` 互为引用（本文件取 `parseAllow` 那一枚布尔解析单点，`addsign.ts`
 * 的 `checkFlowConfig` 反向调本文件的解析期校验），形状与本仓既有的 `engine.ts ↔ addsign.ts`
 * 同族：跨模块符号一律只在**函数体内**取用，求值期不碰。</p>
 */
import { isFirstTaskName, isCountersign, KeyAutoExecute, KeyAdminID } from './engine.js'
import { parseAllow, formatAddSignTime } from './addsign.js'
import { type FlowModel, type FlowNode, type ProcessTask, TypeTask } from './model.js'

/** 节点属性键：已办撤回开关（`properties` 平铺层，缺省 false） */
export const PROP_ALLOW_RECALL = 'allowRecall'
/**
 * 追加式账本键：每条撤回 append `{operator, time, recalledTaskId}`，落在**被撤回的旧行**变量上
 * （原行不改写＝历史即审批记录，账本是唯一追加痕迹）；`recalledTaskId` 指向复活的新行
 * （从历史记录可一步跳到唯一活待办）。
 */
export const KeyRecallHistory = 'tf_recallHistory'

// ─── 逐字判据文案（跨栈统一；规范 06 §processTask/recall 失败文案表） ────────────

export const MSG_NOT_FINISHED = '任务非已完成状态，不可撤回'
export const MSG_NO_PERMISSION = '无权限撤回该任务'
export const MSG_INSTANCE_NOT_DOING = '流程实例非进行中状态，不可撤回'
export const msgWindow = (taskName: string): string =>
  `任务[${taskName}]的后续节点已办理，不能撤回`
export const msgSwitchOff = (nodeName: string): string =>
  `节点[${nodeName}]未开启 allowRecall，不能撤回`

// ─── 解析期两条硬校验文案（规范 02 §4.4，issues/246） ──────────────────────────

export const msgRecallCountersignForbid = (nodeName: string): string =>
  `会签节点[${nodeName}]不允许配置 ${PROP_ALLOW_RECALL}：撤"谁的一票"语义不清`
export const msgRecallFirstTaskForbid = (nodeName: string): string =>
  `首任务节点[${nodeName}]不允许配置 ${PROP_ALLOW_RECALL}：` +
  '申请节点走实例撤回＋重新发起，不需要同实例复活'

// ─── 节点开关解析 ─────────────────────────────────────────────────────────────

/**
 * 读某节点的 `allowRecall`：非任务节点一律 false（java 判 `node instanceof TaskModel` 同档），
 * 任务节点走 `addsign.parseAllow` 那一枚共用解析器（缺省 false；非法值抛配置错误，
 * 不得静默当缺省——键位传本开关的名字，文案不串位）。
 */
export function allowRecallOf(node: FlowNode | undefined): boolean {
  return !!node && node.type === TypeTask &&
    parseAllow(node.properties?.[PROP_ALLOW_RECALL], node.id, PROP_ALLOW_RECALL)
}

/**
 * 解析期两条硬校验（规范 02 §4.4）＋本开关自身的值合法性，两批判据**按此顺序**跑：
 * ① 每个任务节点的 `allowRecall` 值合法性（非法值当场抛，不静默落回缺省——纪律照
 *    `allowAddSign` 先例）；② 会签节点（`performType=1`）禁配（撤"谁的一票"语义不清）；
 * ③ 首任务节点（start 直接后继）禁配（申请节点那手走实例撤回＋重新发起，不需要同实例复活）。
 * 落点＝`addsign.checkFlowConfig`（本栈没有 java 的 `ModelParser` 那一层，三段校验共用那一个入口）。
 */
export function checkRecallFlowConfig(flow: FlowModel): void {
  const tasks = (flow?.nodes ?? []).filter(n => n.type === TypeTask)
  for (const n of tasks) {
    parseAllow(n.properties?.[PROP_ALLOW_RECALL], n.id, PROP_ALLOW_RECALL)
  }
  for (const n of tasks) {
    if (!allowRecallOf(n)) continue
    if (isCountersign(n.properties?.performType)) throw new Error(msgRecallCountersignForbid(n.id))
    if (isFirstTaskName(flow, n.id)) throw new Error(msgRecallFirstTaskForbid(n.id))
  }
}

// ─── 窗口判据（纯函数；判据前置＝报错即零写入的前半） ──────────────────────────

/**
 * 按 `task_parent_id` 血缘收集 target 的全部后代行（栈式扫描，与 java
 * `RecallSupport.collectDescendants` 同一条腿；出栈顺序不改变集合内容）。
 * 血缘在建单不变量里必写（0＝无父 ⇒ 发起那批行的 parent 是字符 '0'），故"有后代"与
 * "无后代"都由数据现状决定，不设第二判据源。
 */
export function collectDescendants(tasks: ProcessTask[], ancestorId: string): ProcessTask[] {
  const result: ProcessTask[] = []
  const frontier: string[] = [ancestorId]
  while (frontier.length > 0) {
    const parent = frontier.pop()!
    for (const t of tasks ?? []) {
      if (t.parentTaskId === parent) {
        result.push(t)
        frontier.push(t.id)
      }
    }
  }
  return result
}

/**
 * 窗口判据（宽口径，owner 2026-11-03 拍）：后代行中**存在任何 FINISHED** ⇒ 抛逐字文案；
 * 否则返回其中仍 DOING 的行（供废弃——后加签/征询成员行、并行分支多支都自然覆盖；
 * 已废弃(99)/已撤回(30) 行既不拦也不重复废弃）。
 */
export function validateWindow(tasks: ProcessTask[], target: ProcessTask): ProcessTask[] {
  const doing: ProcessTask[] = []
  for (const t of collectDescendants(tasks, target.id)) {
    if (t.isFinished()) throw new Error(msgWindow(target.taskName))
    if (t.isDoing()) doing.push(t)
  }
  return doing
}

// ─── 账本（只追加不覆盖，落被撤回的旧行） ──────────────────────────────────────

/**
 * 账本追加（只追加不覆盖），落**被撤回的旧行**变量；`recalledTaskId` 指向复活的新行。
 * 三键固定顺序 `operator, time, recalledTaskId`（java `LinkedHashMap` 同序），
 * `time` 是全生态格式串 `yyyy-MM-dd HH:mm:ss`（规范 §2.4，与 `tf_addSignHistory`／
 * `tf_transferHistory` 同一把尺子，复用 `addsign.formatAddSignTime` 那一个格式化点）。
 *
 * ⚠️ 调用方随后必须把这一行**再落一次库**——本栈两仓存的是快照（java 那边是共享引用，
 * 改了就看得见），不补这一刀账本就丢（与 `addsign.appendHistory` 同一条纪律）。
 */
export function appendRecallHistory(target: ProcessTask | null | undefined, operator: string,
                                     resurrectedTaskId: string, now: Date): void {
  if (!target) return
  const vars = target.variables
  if (!vars) return
  const history: Record<string, any>[] = Array.isArray(vars[KeyRecallHistory])
    ? [...(vars[KeyRecallHistory] as Record<string, any>[])]
    : []
  history.push({
    operator,
    time: formatAddSignTime(now),
    recalledTaskId: resurrectedTaskId,
  })
  vars[KeyRecallHistory] = history
}

/** 读账本（测试与投影用）；无该键／脏值 ⇒ 空表。 */
export function recallHistoryOf(task: ProcessTask | null | undefined): Record<string, any>[] {
  const v = task?.variables?.[KeyRecallHistory]
  return Array.isArray(v) ? (v as Record<string, any>[]) : []
}

/**
 * 名册判据（撤回族三条腿共用：已办撤回鉴权／撤回会签鉴权／复活行参与者）——
 * ⚠️ **不走 `ProcessTask.isAllowed`**：那一支只认 DOING 行（本栈与 java 同病），而撤回面对的
 * 是 FINISHED 行／已办结的主办行，必须按**名册**（`actorIds`，内存仓随行携带、SQL 仓从参与者表
 * 水合，两仓同源）判断。
 */
export function inRoster(task: ProcessTask | null | undefined, operator: string): boolean {
  return !!task && Array.isArray(task.actorIds) && task.actorIds.includes(operator)
}

/**
 * 特权档（`flow.auto` 系统代执行／`flow.admin` 超级管理员）放行——转办／实例撤回／摘人既有同一条
 * 约定，撤回两腿共用；大小写不敏感（java `equalsIgnoreCase`、go `strings.EqualFold` 同尺）。
 */
export function isPrivilegedOperator(operator: string): boolean {
  const lower = (operator ?? '').toLowerCase()
  return lower === KeyAutoExecute.toLowerCase() || lower === KeyAdminID.toLowerCase()
}

/** 已办撤回节点开关快照（issues/251）：办理时由引擎从节点属性盖到本行变量，值＝办理时刻的
 *  `allowRecall` 定义值；查询出口搬运成行顶层 `allowRecall` 供前端预判置灰（只投已办行）。
 *  撤回校验仍以现读定义为权威，快照仅供预判（漂移为设计内）。 */
export const KeyAllowRecall = 'tf_allowRecall'

/** 办理时把当前节点的 `allowRecall` 开关快照进行变量（issues/251）：已办行置灰的"节点开关"
 *  预判从行上读，查询出口只搬运不解析定义。`tf_` 前缀键被实例合并排除（`omitTaskControlKeys`
 *  ＋`mergeExecIntoInstance` 两面立法），不传播；本栈建单只写 `isFirstTaskNode`，待办行无键
 *  （与 jeeflow/go 同形）。撤回校验仍以现读定义为权威。非任务节点与空 args 静默跳过。 */
export function stampAllowRecall(
  args: Record<string, any> | undefined | null,
  node: FlowNode | undefined,
): void {
  if (!args || !node || node.type !== TypeTask) return
  args[KeyAllowRecall] = allowRecallOf(node)
}
