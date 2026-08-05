import type { CcInstanceRow, DefineRow, InstanceRow, TaskRow, ProcessDefine, ProcessDesign, ProcessDesignHis, ProcessInstance, ProcessSurrogate, ProcessTask, UserInfo } from './model.js'

// 查询条件（issues/05-5：m_ 前缀参数解析产物，对齐 Java PageQuery.Condition）
export interface QueryCondition {
  column: string
  operator: string
  value: any
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

  // getSurrogate 查询指定时间生效中的委托（enabled=1 + 时间窗内；processName 精确优先，空值全流程兜底）
  getSurrogate(operator: string, processName: string, at?: Date): Promise<ProcessSurrogate | null>
}
