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

  // PageCcInstances 我的抄送分页（v1.3.0，对齐 Java pageCcInstances）：
  // 按抄送人 actorId 过滤实例列表，返回行数据（含关联定义名/版本）+ 总数
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
  // （enabled 严格 1 / 自委托过滤 / 时间窗任一侧空=不限，at 为空则不比较窗口）。
  // 该作用域无记录才兜底 processName 为空的"全流程委托"；最新一条不生效 ⇒ null，
  // 同层内不回落更旧那条，但精确作用域判否后仍要看全流程作用域（条款 1.4 后半句）。见 src/surrogate-rule.ts。
  getSurrogate(operator: string, processName: string, at?: Date): Promise<ProcessSurrogate | null>
}
