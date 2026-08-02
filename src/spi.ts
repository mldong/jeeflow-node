import type { CcInstanceRow, ProcessDefine, ProcessDesign, ProcessDesignHis, ProcessInstance, ProcessSurrogate, ProcessTask, UserInfo } from './model.js'

export interface ProcessRepository {
  findDefineById(id: number): Promise<ProcessDefine | null>
  // findDefineByName 按流程编码查最新一条定义（v1.1.0，Facade deploy 版本管理用）
  findDefineByName(name: string): Promise<ProcessDefine | null>
  // 定义写操作（v1.0.1，集成反馈①）：保存/更新/启停/删除流程定义
  saveDefine(define: ProcessDefine): Promise<void>
  updateDefine(define: ProcessDefine): Promise<void>
  updateDefineState(defineId: number, state: number): Promise<void>
  removeDefine(defineId: number): Promise<void>
  findInstanceById(id: number): Promise<ProcessInstance | null>
  saveInstance(inst: ProcessInstance): Promise<void>
  updateInstance(inst: ProcessInstance): Promise<void>

  findTaskById(taskId: number): Promise<ProcessTask | null>
  saveTask(task: ProcessTask): Promise<void>
  updateTask(task: ProcessTask): Promise<void>
  findDoingTasks(instanceId: number, taskNames?: string[]): Promise<ProcessTask[]>
  findDoneTasks(instanceId: number, taskNames?: string[]): Promise<ProcessTask[]>
  findHistoryTasks(instanceId: number): Promise<ProcessTask[]>

  findTaskActors(taskId: number): Promise<string[]>
  addTaskActor(taskId: number, actors: string[]): Promise<void>
  removeTaskActor(taskId: number, actors: string[]): Promise<void>

  createCcInstance(instanceId: number, creator: string, ...actorIds: string[]): Promise<void>
  updateCcStatus(instanceId: number, actorId: string): Promise<void>

  // PageCcInstances 我的抄送分页（v1.3.0，对齐 Java pageCcInstances）：
  // 按抄送人 actorId 过滤实例列表，返回行数据（含关联定义名/版本）+ 总数
  pageCcInstances(pageNum: number, pageSize: number, actorId: string): Promise<{ rows: CcInstanceRow[]; total: number }>
}

export interface UserProvider {
  getUser(userId: string): Promise<UserInfo | null>
}

export interface IDGenerator {
  nextId(): number
}

export interface ExpressionEvaluator {
  eval(expr: string, vars: Record<string, any>): Promise<any>
}

// ── 扩展仓储 SPI（v1.1.0，可选）——流程设计 / 设计历史 / 委托代理 ──

export interface ProcessExtRepository {
  // 流程设计（wf_process_design）
  findDesignById(id: number): Promise<ProcessDesign | null>
  saveDesign(d: ProcessDesign): Promise<void>
  updateDesign(d: ProcessDesign): Promise<void>
  removeDesign(id: number): Promise<void>
  pageDesigns(pageNum?: number, pageSize?: number, filters?: Record<string, any>): Promise<[ProcessDesign[], number]>

  // 设计历史（wf_process_design_his）
  saveDesignHis(his: ProcessDesignHis): Promise<void>
  listDesignHis(designId: number): Promise<ProcessDesignHis[]>

  // 委托代理（wf_process_surrogate）
  findSurrogateById(id: number): Promise<ProcessSurrogate | null>
  saveSurrogate(s: ProcessSurrogate): Promise<void>
  updateSurrogate(s: ProcessSurrogate): Promise<void>
  removeSurrogate(id: number): Promise<void>
  pageSurrogates(pageNum?: number, pageSize?: number, filters?: Record<string, any>): Promise<[ProcessSurrogate[], number]>

  // getSurrogate 查询指定时间生效中的委托（enabled=1 + 时间窗内；processName 精确优先，空值全流程兜底）
  getSurrogate(operator: string, processName: string, at?: Date): Promise<ProcessSurrogate | null>
}
