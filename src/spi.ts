import type { CcInstanceRow, DefineRow, InstanceRow, TaskRow, ProcessDefine, ProcessDesign, ProcessDesignHis, ProcessInstance, ProcessSurrogate, ProcessTask, UserInfo } from './model.js'

// 查询条件（issues/05-5：m_ 前缀参数解析产物，对齐 Java PageQuery.Condition）
export interface QueryCondition {
  column: string
  operator: string
  value: any
}

// ═══ 归属谓词基建（issues/129 案 A · 第二层「仓储兜底」）═══

/**
 * 归属谓词列：这几列定义「这条记录属于谁」，空值**绝不能**等于「不过滤」。
 * 取自门面实际下发的那四条（逐字对齐 java `JdbcProcessRepository.OWNERSHIP_COLUMNS`，
 * 本栈列名写法与 java 相同——`wf_process_task.operator` / 实例 join 出的 `pi.operator` /
 * 任务参与者表 `wf_process_task_actor.actor_id` / 抄送表 `wf_process_cc.actor_id`）：
 *   processInstance/page → t.operator、processTask/todoList → pta.actor_id、
 *   processTask/doneList → t.operator（+ pi.operator 带出的实例发起人）、processInstance/ccList → cc.actor_id
 * 口径见 jeeflow-doc `spec/06-facade.md` §2.5。
 */
export const OWNERSHIP_COLUMNS: ReadonlySet<string> = new Set([
  't.operator', 'pi.operator', 'pta.actor_id', 'cc.actor_id',
])

/** 空值判定（对齐 java `val == null || ((String) val).trim().isEmpty()`）：null/undefined/全空白串 */
export function isBlankValue(val: unknown): boolean {
  return val == null || (typeof val === 'string' && val.trim() === '')
}

/**
 * 归属谓词 + 空值 ⇒ **空页**（issues/129 案 A 第二层）。
 * 只收 `OWNERSHIP_COLUMNS` 上的 EQ 条件：动态 where 里「空值当作没填」那句是 PageQuery 对
 * `m_LIKE_*` 等**可选过滤**的通用放行，整体改掉会把可选过滤一起改坏（spec 06-facade.md §2.5 ⚠️）。
 */
export function isBlankOwnership(column: string, operator: string, val: unknown): boolean {
  return OWNERSHIP_COLUMNS.has(column) && operator.toUpperCase() === 'EQ' && isBlankValue(val)
}

/**
 * 归属证据的**有效性**判据（issues/141 G1 · 逐字对齐 java
 * `JdbcProcessRepository#hasEffectiveCondition` 的反面）：在 `isBlankValue` 的三形
 * （null / undefined / 全空白串）之上再收一档**空集合**——`[]` 表达的是「谁都没有」，
 * 与空串同档。这一档不补上，同一份数据在两仓会各说各话：内存仓 `[].trim()` 直接 TypeError，
 * SQL 仓把数组当标量绑进 `cc.actor_id = ?` 下库（既不是空页也不是报错口径统一）。
 */
export function isBlankOwnershipValue(val: unknown): boolean {
  if (isBlankValue(val)) return true
  return Array.isArray(val) && val.length === 0
}

/** 抄送归属列（`pageCcInstances` 的归属证据落在这一列上，与 OWNERSHIP_COLUMNS 里那枚同名）。 */
const CC_OWNERSHIP_COLUMN = 'cc.actor_id'

/**
 * 抄送分页的**归属条件必填**判据（issues/141 G1 · spec 06 §2.5「抄送分页同一条尺子」）。
 *
 * 本栈的归属证据有两路：门面下发的**位置参** `actorId`（java 下发的是 `cc.actor_id EQ` 条件，
 * 形状不同、义务相同）与 `conditions` 里打在 `cc.actor_id` 上的条件。判据：
 *   ① 位置参无效（缺 / 空串 / 全空白 / null / 空集合）⇒ **空页**；
 *   ② `conditions` 里凡是打在 `cc.actor_id` 上的条件，只要有一条值无效 ⇒ **空页**
 *      （含 java 那格「空 IN ⇒ 空页」；这一路不看 operator，与 java `hasEffectiveCondition` 一致）；
 *   ③ 非归属列（`m_LIKE_businessNo` 等**可选过滤**）的空值放行**不变**，仍按「没填」忽略——
 *      本判据只看 `cc.actor_id`，绝不把可选过滤一起改成空页。
 *
 * ⚠️ 两仓（`JdbcRepository` / `MemoryRepository`）**共用这一份实现**，不是各写一遍：
 * 「同一栈两个仓储两个答案」正是 issues/117 场景 27 立过法的形状，判据只留一处才不可能分叉。
 */
export function hasEffectiveCcOwnership(actorId: unknown, conditions?: QueryCondition[]): boolean {
  if (isBlankOwnershipValue(actorId)) return false
  for (const c of conditions ?? []) {
    if (c.column !== CC_OWNERSHIP_COLUMN) continue
    if (isBlankOwnershipValue(c.value)) return false
  }
  return true
}

// ── 统计行类型（v1.8.25，issues/103）──

export interface InstanceStatsRow {
  defineId: string
  state: number
  operator: string
  createTime: Date | string | null
}

export interface TaskStatsRow {
  operator: string
  displayName: string
  performType: number
  createTime: Date | string | null
  finishTime: Date | string | null
  expireTime: Date | string | null
}

export interface ProcessRepository {
  findDefineById(id: string): Promise<ProcessDefine | null>
  // findDefineByName 按流程编码查最新一条定义（v1.1.0，Facade deploy 版本管理用）
  findDefineByName(name: string): Promise<ProcessDefine | null>
  // 定义写操作（v1.0.1，集成反馈①）：保存/更新/启停/删除流程定义
  saveDefine(define: ProcessDefine): Promise<void>
  updateDefine(define: ProcessDefine): Promise<void>
  updateDefineState(defineId: string, state: number): Promise<void>
  removeDefine(defineId: string): Promise<void>
  findInstanceById(id: string): Promise<ProcessInstance | null>
  saveInstance(inst: ProcessInstance): Promise<void>
  updateInstance(inst: ProcessInstance): Promise<void>

  findTaskById(taskId: string): Promise<ProcessTask | null>
  saveTask(task: ProcessTask): Promise<void>
  updateTask(task: ProcessTask): Promise<void>
  findDoingTasks(instanceId: string, taskNames?: string[]): Promise<ProcessTask[]>
  findDoneTasks(instanceId: string, taskNames?: string[]): Promise<ProcessTask[]>
  findHistoryTasks(instanceId: string): Promise<ProcessTask[]>

  findTaskActors(taskId: string): Promise<string[]>
  addTaskActor(taskId: string, actors: string[]): Promise<void>
  removeTaskActor(taskId: string, actors: string[]): Promise<void>

  createCcInstance(instanceId: string, creator: string, ...actorIds: string[]): Promise<void>
  updateCcStatus(instanceId: string, actorId: string): Promise<void>

  /**
   * issues/141 G2 写侧判重的**读侧**（spec 06 §4「抄送写侧判重＝幂等空操作」）：读某实例
   * **已存在**的 cc 行 actor id，供建 cc 的三条入口（发起 `f_ccActors`／办理 `tf_ccActors`／
   * 门面手动 `createCCInstance`）判重用——三条腿共用引擎那一支漏斗（§11.7）。
   *
   * <p>声明成**可选**是刻意的（java 侧对应 `IProcessRepository` 的 `default` 方法）：未实现的
   * 第三方仓储走 {@link defaultCreateCcInstanceIfAbsent} ⇒ 视作「没有既有行」⇒ 全量建行、全量 fire，
   * 与旧行为逐字一致，SPI 源码兼容不破。本包自带的两仓（`JdbcRepository` / `MemoryRepository`）
   * **必须**实现：否则 G1 那条「同一栈 SQL 仓与内存仓两个答案」的分叉在写侧重演一遍。
   */
  findCcActorIds?(instanceId: string): Promise<string[]>

  /**
   * issues/141 G2：写侧**幂等**建 cc 行。同一 `(instanceId, actorId)` 已有 cc 行时**跳过**——
   * ①不新增行 ②不重置未读状态（`state`）③不更新原行时间（`create_time`/`update_time` 逐字不变），
   * 重复抄送同一个人是数据面上的 no-op（owner 2026-09-29 明确「不需要重置」，不产生"再提醒一次"语义）；
   * 返回**实际新建**的 actor 子集（顺序与入参一致，同一次调用内的重复也折叠）。
   *
   * <p>为什么返回子集而不是 `void`：spec §11.2 原则 1「码值表达发生了什么事实」⇒ 没发生"创建"
   * 就不得 fire `CC_CREATE`（码 4）。逐人 fire 的入参一律换成这个子集，子集为空整支不 fire。
   * 查询侧不引入 DISTINCT、历史重复行也不清理（owner 拍为接受既成事实）。
   *
   * <p>未实现的仓储由 {@link defaultCreateCcInstanceIfAbsent} 兜出 java 的 `default` 语义。
   */
  createCcInstanceIfAbsent?(instanceId: string, creator: string, ...actorIds: string[]): Promise<string[]>

  // PageCcInstances 我的抄送分页（v1.3.0，对齐 Java pageCcInstances）：
  // 按抄送人 actorId 过滤实例列表，返回行数据（含关联定义名/版本）+ 总数。
  //
  // ⚠️ **归属条件必填**（issues/141 G1 · spec 06 §2.5）：`cc.actor_id` 上没有有效归属证据（缺 / 空值三形 /
  // 空集合）时必须返回**空页**（`rows=[]`、`total=0`），严禁退化成"这条不加"而返回全部实例；
  // 判据是 {@link hasEffectiveCcOwnership}，SQL 仓与内存仓共用一份实现，两仓必须同答案。
  // 非归属列的空值放行不受影响（`m_LIKE_*` 传空串仍按"没填"忽略）。
  pageCcInstances(pageNum: number, pageSize: number, actorId: string, conditions?: QueryCondition[]): Promise<{ rows: CcInstanceRow[]; total: number }>

  // ── 核心表分页（v1.5.0，对齐 Java pageDefines/pageInstances/pageTodoTasks/pageDoneTasks）──
  pageDefines(pageNum: number, pageSize: number, conditions?: QueryCondition[]): Promise<{ rows: DefineRow[]; total: number }>
  pageInstances(pageNum: number, pageSize: number, operator: string, conditions?: QueryCondition[]): Promise<{ rows: InstanceRow[]; total: number }>
  pageTodoTasks(pageNum: number, pageSize: number, actorId: string, conditions?: QueryCondition[]): Promise<{ rows: TaskRow[]; total: number }>
  pageDoneTasks(pageNum: number, pageSize: number, operator: string, conditions?: QueryCondition[]): Promise<{ rows: TaskRow[]; total: number }>

  // ── 统计查询（v1.8.25，issues/103）──
  queryInstancesForStats(stateIn?: number[] | null, start?: Date | null, end?: Date | null): Promise<InstanceStatsRow[]>
  queryTasksForStats(taskState?: number, start?: Date | null, end?: Date | null): Promise<TaskStatsRow[]>
  statsPendingAndOverdueCount(): Promise<[number, number]>
  statsCompletedTaskAggregate(): Promise<[number, number, number, number]>
  statsAvgCompletedDurationSeconds(start?: Date | null, end?: Date | null): Promise<number>
  statsDefineGroup(start?: Date | null, end?: Date | null, limit?: number): Promise<Record<string, any>[]>
  statsStuckNodeGroup(limit?: number): Promise<Record<string, any>[]>
  statsStuckApproverGroup(limit?: number): Promise<Record<string, any>[]>
  statsCompletedInstanceDurations(start?: Date | null, end?: Date | null): Promise<number[]>
}

/**
 * issues/141 G2 —— java `IProcessRepository#createCcInstanceIfAbsent` 那条 `default` 在 TS 里的对应物
 * （接口给不出默认实现，所以做成自由函数，两仓与引擎共用同一份判重逻辑）。
 *
 * 只依赖 `createCcInstance` ＋ 可选的 `findCcActorIds`，**不调用** `createCcInstanceIfAbsent`，
 * 所以自带实现的仓储可以直接 `return defaultCreateCcInstanceIfAbsent(this, …)` 而不会自我递归。
 *
 * 行为：读该实例既有 cc 行 ⇒ 折掉已存在的人与本次入参内的重复 ⇒ 只插新人 ⇒ 返回**实际新建**的子集。
 * 仓储未实现 `findCcActorIds` 时既有集合视作空 ⇒ 与旧 `createCcInstance` 全量插入逐字一致
 * （java 的 default 同理，第三方仓储不被静默改变行为）。
 */
export async function defaultCreateCcInstanceIfAbsent(
  repo: Pick<ProcessRepository, 'createCcInstance' | 'findCcActorIds'>,
  instanceId: string,
  creator: string,
  actorIds: string[],
): Promise<string[]> {
  const existing = repo.findCcActorIds ? await repo.findCcActorIds(instanceId) : []
  const fresh: string[] = []
  for (const actorId of actorIds) {
    if (actorId == null) continue
    if (existing.includes(actorId) || fresh.includes(actorId)) continue
    fresh.push(actorId)
  }
  if (fresh.length > 0) await repo.createCcInstance(instanceId, creator, ...fresh)
  return fresh
}

export interface UserProvider {
  getUser(userId: string): Promise<UserInfo | null>
}

export interface OrgUserProvider {
  /** 部门领导（deptId → 领导 userId 列表） */
  findDeptLeaders(deptId: string): Promise<string[]>
  /** 部门分管领导（deptId → 分管领导 userId 列表） */
  findDeptMainLeaders(deptId: string): Promise<string[]>
  /** 按角色取人（roleCode → userId 列表） */
  findByRole(roleCode: string): Promise<string[]>
}

export interface IDGenerator {
  nextId(): string
}

export interface ExpressionEvaluator {
  eval(expr: string, vars: Record<string, any>): Promise<any>
}

// ── 扩展仓储 SPI（v1.1.0，可选）——流程设计 / 设计历史 / 委托代理 ──

export interface ProcessExtRepository {
  // 流程设计（wf_process_design）
  findDesignById(id: string): Promise<ProcessDesign | null>
  saveDesign(d: ProcessDesign): Promise<void>
  updateDesign(d: ProcessDesign): Promise<void>
  removeDesign(id: string): Promise<void>
  pageDesigns(pageNum?: number, pageSize?: number, filters?: Record<string, any>, conditions?: QueryCondition[]): Promise<[ProcessDesign[], number]>

  // 设计历史（wf_process_design_his）
  saveDesignHis(his: ProcessDesignHis): Promise<void>
  listDesignHis(designId: string): Promise<ProcessDesignHis[]>

  // 委托代理（wf_process_surrogate）
  findSurrogateById(id: string): Promise<ProcessSurrogate | null>
  saveSurrogate(s: ProcessSurrogate): Promise<void>
  updateSurrogate(s: ProcessSurrogate): Promise<void>
  removeSurrogate(id: string): Promise<void>
  pageSurrogates(pageNum?: number, pageSize?: number, filters?: Record<string, any>, conditions?: QueryCondition[]): Promise<[ProcessSurrogate[], number]>

  // getSurrogate 查询指定时间生效中的委托（06 §4.5 条款 1.4 + issues/123）：**先**按主键 id
  // 取该流程作用域内**最新一条**（不带生效判据过滤），**再**由四判据裁决这一条
  // （enabled 只认**数值** 1 / 自委托过滤 / 时间窗任一侧空=不限，at 为空则不比较窗口）。
  // issues/130 案 A：判据不吃串，所以整数列被驱动字符串化（回读成 '1'）必须在**实现侧**交判据前
  // 还原（内置 SQL 仓走 surrogateHydrateEnabled；自定义 SPI 仓储不还原则按停用处理）；
  // '1.0' / ' 1' / 'abc' / true / 0 / 2 / null 一律不生效，不得顺手放宽成 Number(v)===1。
  // 该作用域无记录才兜底 processName 为空的"全流程委托"；最新一条不生效 ⇒ null，
  // 同层内不回落更旧那条，但精确作用域判否后仍要看全流程作用域（条款 1.4 后半句）。见 src/surrogate-rule.ts。
  getSurrogate(operator: string, processName: string, at?: Date): Promise<ProcessSurrogate | null>
}
