/**
 * 动态协办（aidant，issues/253）——协办行识别、等待闸计数、投影、轮次与追加式账本的
 * 纯函数家族（Node 栈）。
 *
 * 判据出处：规范 04「动态协办（aidant）」整节（派生规则／推进闸与等待闸／协办行能力与边界／
 * 留痕与投影）＋规范 06 §2.7 协议键与 §processTask/aidant、文末跨栈统一失败文案表「协办六行」。
 * 本能力**无节点开关**（节点级 `taskType=1` 解析期禁配，issues/252）、不新增节点类型、
 * 不新增 submitType 档、无 DDL（协办行即普通任务行）、不新增事件码（协办行建/结走既有码 3/5）。
 *
 * 形状基准＝jeeflow-java 参考实现（issues/253 实施轮工作树现读）的 `core/AidantSupport.java`
 * （纯函数家族）＋ `core/JeeflowEngineImpl.aidantTask`／`completeAidantWithoutDrive`／
 * `prepareExecution` 里的 `gateWait` ＋ `model/TaskModel.abandonAidantOnLeave` ＋
 * `handler/impl/CountersignHandler`（会签合并显式排除协办行）；
 * `jeeflow-go/engine/aidant.go` 与 `jeeflow-python/jeeflow/aidant.py` 是同一条移植腿的另两份样本。
 *
 * 语义一句话：主办把"这活"交给别人干——按人派生 `task_type=1` 的协办子行，**主办行原样保留
 * DOING**；协办行办结不驱动流程，节点推进仍由主办行办结触发。与征询的本质差异：征询收的是
 * "意见"且**强制等收齐**；协办交的是"活"，**等不等由派生参数 waitCompletion 决定**（缺省 false＝不等）。
 *
 * # 与征询的分辨判据＝task_type（别简化）
 *
 * 两族子行都是 parent 指向主办行＋同节点同名：协办行 `task_type=1`、征询成员行 `task_type=0`。
 * 等待闸只数协办行、征询收齐闸只数成员行，各数各的（规范 04「与征询允许同节点并存」）。
 * **同名过滤不可省**：主办办结推进后，下一节点行的 parent 同样是主办行 id（建单不变量），
 * 只认 parent 会把下游行误当协办行——清场腿会误废弃它们。
 *
 * 本模块只做纯函数（判据/账本/投影），派生腿与闸门在 `engine.ts`、门面归一在 `facade.ts`
 * ——与 java 的 AidantSupport / JeeflowEngineImpl / JeeflowFacade 三层分工同构。
 */
import { formatAddSignTime } from './addsign.js'
import { type ProcessTask, TaskState, TaskType } from './model.js'

// ─── 键名（逐字对齐 Java FlowConst / AidantSupport） ──────────────────────────

/**
 * 动态协办账本：`{round, fromActor, toActors, reason, time, operator}` 只追加，落**主办行**变量
 * （形状照 `tf_addSignHistory`，键序锁定、time 为 §2.4 字符串）。离开节点清场未办结协办行时
 * 追加一条带 `abandoned: true` 的条目（照征询撤回的 `revoked`）。
 */
export const KeyAidantHistory = 'tf_aidantHistory'
/** 派生原因（选填，字符串）：盖每条协办行（单行出证自足）；**不占 `tf_approvalComment`**。 */
export const KeyAidantReason = 'tf_aidantReason'
/**
 * 等待闸开关：派生时把 `waitCompletion` 盖在**主办行**变量上，缺省 false＝主办不等协办办结
 * 即可推进。`tf_` 前缀使实例合并自动剥键（不传播，与 `tf_allowRecall` 同通道）；
 * 投影 `ext.aidant.wait` 同源。
 */
export const KeyAidantWait = 'tf_aidantWait'

// ─── 逐字判据文案（跨栈统一；规范 06 文末失败文案表「协办六行」＋等待闸那句） ────

export const MSG_NO_ACTORS = 'actorIds 必填'
export const MSG_NO_PERMISSION = '无权限派生协办任务'
export const MSG_NOT_DOING = '任务非进行中，不可派生协办'
export const MSG_DUPLICATE = '该人已有未办结的协办任务'
export const MSG_NO_RECURSION = '协办任务不能再派生协办'
export const MSG_TASK_NOT_FOUND = '任务不存在'
export const msgWaitPending = (taskName: string, submitted: number, total: number): string =>
  `节点[${taskName}]协办未办结（已办结 ${submitted}/${total}），不能办理`

// ─── 协办行识别（纯函数） ─────────────────────────────────────────────────────

/** 协办行判定＝`task_type=1`（SECONDARY）。这是两族子行唯一的分辨判据。 */
export function isAidantRow(row: ProcessTask | null | undefined): boolean {
  return !!row && Number(row.taskType) === TaskType.Secondary
}

/**
 * 协办行＝parent 指向主办行**且同节点同名且 task_type=1** 的行。
 * 同名过滤与 task_type 过滤都不可省，理由见文件头「与征询的分辨判据」段。
 */
export function aidantRows(tasks: ProcessTask[], host: ProcessTask | null | undefined): ProcessTask[] {
  const out: ProcessTask[] = []
  if (!host || !host.id) return out
  for (const t of tasks ?? []) {
    if (isAidantRow(t) && t.parentTaskId === host.id && t.taskName === host.taskName) out.push(t)
  }
  return out
}

/**
 * 等待闸原料：在册协办行总数与已办结（FINISHED）数——**已废弃(99) 行（离开节点清场的）
 * 不算在册**（规范 04「计数跳过已废弃(99) 行」）。返回 `[total, submitted]`。
 */
export function countAidant(tasks: ProcessTask[], host: ProcessTask): [number, number] {
  let total = 0
  let submitted = 0
  for (const t of aidantRows(tasks, host)) {
    if (t.taskState === TaskState.Abandoned) continue
    total++
    if (t.isFinished()) submitted++
  }
  return [total, submitted]
}

/** 未办结协办行（DOING）——等待闸的判据集合，也是离开节点时的清场集合。 */
export function pendingAidant(tasks: ProcessTask[], host: ProcessTask): ProcessTask[] {
  return aidantRows(tasks, host).filter(t => t.isDoing())
}

/**
 * 等待闸开关（`waitCompletion`）：派生时盖在**主办行**变量上，缺省 false＝不等。
 * 多轮派生时后一次的值生效（投影 `ext.aidant.wait` 同源）。
 *
 * 非法值按缺省 false（照 java `Boolean.parseBoolean`：只认 "true"，大小写不敏感）——
 * 契约只定义了 bool 档，**不为非法值新造文案**（协办六行之外不加第七行）。
 */
export function waitOf(host: ProcessTask | null | undefined): boolean {
  if (!host) return false
  const v = host.variables?.[KeyAidantWait]
  if (v === null || v === undefined) return false
  if (typeof v === 'boolean') return v
  return String(v).trim().toLowerCase() === 'true'
}

/**
 * 等待闸（规范 04「推进闸与等待闸」）：`waitCompletion=true` 时主办行办结前判
 * "不存在 DOING 协办行"，未齐 ⇒ 逐字文案报错、零写入。协办行自身不受本闸约束
 * （它办结本来就不驱动流程）；`waitCompletion=false`（缺省）原样放行。
 *
 * 必须由引擎排在 `completeTask` **之前**——内存仓储无回滚，判据后置时"报错"那一次调用
 * 结束后主办待办已经消失（与后加签/退回守卫同一规矩）。
 */
export function gateWait(tasks: ProcessTask[], host: ProcessTask | null | undefined): void {
  if (!host || isAidantRow(host) || !waitOf(host)) return
  if (pendingAidant(tasks, host).length === 0) return
  const [total, submitted] = countAidant(tasks, host)
  throw new Error(msgWaitPending(host.taskName, submitted, total))
}

/**
 * 从行集合里剔掉协办行（task_type=1）——会签合并计数与"本节点还有兄弟待办"判据共用这一枚
 * （规范 04「不计入会签合并计数」＋「缺省 false 主办可随时推进」）。
 */
export function filterOutAidant(tasks: ProcessTask[]): ProcessTask[] {
  return (tasks ?? []).filter(t => !isAidantRow(t))
}

// ─── 轮次与账本 ───────────────────────────────────────────────────────────────

/** 读账本（测试与投影用）；无该键／脏值 ⇒ 空表。 */
export function historyOf(task: ProcessTask | null | undefined): Record<string, any>[] {
  const v = task?.variables?.[KeyAidantHistory]
  return Array.isArray(v) ? (v as Record<string, any>[]) : []
}

/**
 * 主办行当前轮次＝账本末条 `round`（每次派生追加一条＝轮次推进；**清场记账不消耗轮次**）。
 */
export function lastRound(host: ProcessTask | null | undefined): number {
  const history = historyOf(host)
  for (let i = history.length - 1; i >= 0; i--) {
    const r = Number(history[i]?.round)
    if (Number.isFinite(r) && r > 0) return r
  }
  return 0
}

/**
 * 派生账本追加（只追加不覆盖），落**主办行**变量；六键
 * `{round, fromActor, toActors, reason, time, operator}`（规范 06 §2.7），
 * `reason` 空串兜底、`time` 一律 §2.4 字符串。
 *
 * 主办行在派生时不办结，`completeTask` 的变量合并是并入而非整体替换，故账本能活到主办办结
 * 之后（与转办/征询账本同一条存活理由）。
 * ⚠️ 调用方随后必须把主办行**再落一次库**（快照仓储纪律，同 `appendCollectHistory`）。
 */
export function appendAidantHistory(host: ProcessTask, operator: string, toActors: string[],
                                     round: number, reason: string, now: Date): void {
  append(host, baseEntry(operator, toActors, round, reason, now))
}

/**
 * 清场账本追加：`abandoned: true` 标记本条是"离开节点废弃"（形状照征询撤回条目的
 * `revoked: true`），六键原序不动，`toActors`＝被废弃的人。
 */
export function appendAbandonHistory(host: ProcessTask, operator: string,
                                      abandonedActors: (string | null)[], round: number, now: Date): void {
  const entry = baseEntry(operator, [], round, '', now)
  entry.toActors = [...abandonedActors]
  entry.abandoned = true
  append(host, entry)
}

/** 账本条目六键固定 camelCase（`round, fromActor, toActors, reason, time, operator`），照 java 键序。 */
function baseEntry(operator: string, toActors: string[], round: number, reason: string,
                   now: Date): Record<string, any> {
  return {
    round,
    fromActor: operator,
    toActors: [...toActors],
    reason: reason ?? '',
    time: formatAddSignTime(now),
    operator,
  }
}

function append(host: ProcessTask | null | undefined, entry: Record<string, any>): void {
  if (!host) return
  const vars = host.variables
  if (!vars) return
  const history: Record<string, any>[] = Array.isArray(vars[KeyAidantHistory])
    ? [...(vars[KeyAidantHistory] as Record<string, any>[])]
    : []
  history.push(entry)
  vars[KeyAidantHistory] = history
}

// ─── 投影 ─────────────────────────────────────────────────────────────────────

/**
 * 投影（规范 06 §2.7）：主办行 `ext.aidant`
 * ＝`{active, round, total, submitted, actors:[{actor, taskId, state}], wait}`；无协办行 ⇒ null
 * （门面那侧"不写键"）。从 `task_parent_id`＋`task_type` **现算**、不落新存储，
 * 跳过 99 废弃行（清场的行不进投影，与征询投影同口径）。
 */
export function buildProjection(tasks: ProcessTask[], host: ProcessTask): Record<string, any> | null {
  const rows = aidantRows(tasks, host)
  if (rows.length === 0) return null
  let total = 0
  let submitted = 0
  const actors: Record<string, any>[] = []
  for (const t of rows) {
    if (t.taskState === TaskState.Abandoned) continue
    total++
    if (t.isFinished()) submitted++
    actors.push({
      actor: t.actorIds && t.actorIds.length > 0 ? t.actorIds[0] : null,
      taskId: t.id,
      state: t.taskState,
    })
  }
  return {
    active: submitted < total,
    round: lastRound(host),
    total,
    submitted,
    actors,
    wait: waitOf(host),
  }
}