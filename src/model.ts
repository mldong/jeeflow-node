// ─── LogicFlow JSON Types ─────────────────────────────────────────────────────

export interface FlowModel {
  name: string
  displayName: string
  type: string
  nodes: FlowNode[]
  edges: FlowEdge[]
}

export interface FlowNode {
  id: string
  type: string
  x: number
  y: number
  properties: Record<string, any>
  text: { value: string }
}

export interface FlowEdge {
  id: string
  sourceNodeId: string
  targetNodeId: string
  properties: Record<string, any>
  text?: { value: string }
}

// ─── Node Type Constants ──────────────────────────────────────────────────────

export const TypeStart    = 'snaker:start'
export const TypeEnd      = 'snaker:end'
export const TypeTask     = 'snaker:task'
export const TypeDecision = 'snaker:decision'
export const TypeFork     = 'snaker:fork'
export const TypeJoin     = 'snaker:join'
export const TypeCustom   = 'snaker:custom'

// ─── Domain Types ─────────────────────────────────────────────────────────────

// ⚠️ 引擎 id 全程 string（issue 38 E9）：Java 雪花 id（>2^53）在 JS number 下丢精度，
// 跨语言共享流程定义/实例必须用字符串承载。mysql2 需配置 supportBigNumbers+bigNumberStrings。

export interface ProcessDefine {
  id: string
  name: string
  displayName: string
  type: string
  state: number
  content: Uint8Array | string
  version: number
  createTime: Date
  createUser: string
  updateTime: Date
  updateUser: string
}

// ─── 管理扩展（v1.1.0）──────────────────────────────────────────────────────

export interface ProcessDesign {
  id: string
  name: string
  displayName: string
  type: string
  icon?: string
  isDeployed: number
  remark?: string
  createTime: Date
  createUser: string
  updateTime: Date
  updateUser: string
}

export interface ProcessDesignHis {
  id: string
  processDesignId: string
  content: Uint8Array | string
  createTime: Date
  createUser: string
}

export interface ProcessSurrogate {
  id: string
  processName?: string
  operator: string
  surrogate: string
  startTime?: Date
  endTime?: Date
  enabled: number
  createTime: Date
  createUser: string
  updateTime: Date
  updateUser: string
}

export enum InstanceState {
  Doing     = 10,
  Done      = 20,
  Withdraw  = 30,
  Interrupt = 40,
  Reject    = 45,
  Pending   = 50,
  Abandon   = 99,
}

export enum TaskState {
  Doing     = 10,
  Done      = 20,
  Withdraw  = 30,
  Interrupt = 40,
  Pending   = 50,
  Abandoned = 99,
}

// ─── 字典枚举（v1.4.0，对齐 Java enums，值与 boot3 字典一致） ───────────────

/** 流程定义状态（wf_process_define_state） */
export enum DefineState {
  Disable = 0,
  Enable  = 1,
}

/** 流程提交类型（wf_process_submit_type） */
export enum SubmitType {
  Apply               = 0,
  Agree               = 1,
  Reject              = 2,
  Rollback            = 3,
  Jump                = 4,
  ReApply             = 5,
  RollbackToOperator  = 6,
  CountersignDisagree = 20,
}

/** 任务类型（wf_process_task_type） */
export enum TaskType {
  Major     = 0,
  Secondary = 1,
  Record    = 2,
}

/** 任务参与方式（wf_process_task_perform_type） */
export enum PerformType {
  Normal     = 0,
  Countersign = 1,
}

/** 会签类型（wf_countersign_type） */
export enum CountersignType {
  Parallel   = 0,
  Sequential = 1,
}

export const BusinessNoKey = 'BUSINESS_NO'

// ─── 聚合根：ProcessInstance ───────────────────────────────────────────────────

export class ProcessInstance {
  id!: string
  parentId?: string
  defineId!: string
  state!: InstanceState
  parentNodeName!: string
  businessNo!: string
  operator!: string
  expireTime?: Date
  variables!: Record<string, any>
  tasks!: ProcessTask[]
  createTime!: Date
  createUser!: string
  updateTime!: Date
  updateUser!: string

  constructor(data: any) {
    Object.assign(this, data)
  }

  /** 工厂——创建流程实例 */
  static create(id: string, defineId: string, operator: string, vars: Record<string, any>, now: Date): ProcessInstance {
    return new ProcessInstance({
      id, defineId, state: InstanceState.Doing,
      operator, variables: vars,
      parentNodeName: '', businessNo: vars[BusinessNoKey] ?? '',
      createTime: now, updateTime: now, createUser: operator, updateUser: operator,
      tasks: [],
    })
  }

  /** 完成任务（子实体状态转换 + 实例变量合并） */
  completeTask(task: ProcessTask, operator: string, vars: Record<string, any>, now: Date): void {
    task.finish(operator, vars, now)
    this.variables = vars
    this.updateTime = now
    this.updateUser = operator
  }

  /** 废弃单个任务 */
  abandonTask(task: ProcessTask, now: Date): void {
    task.abandon(now)
    this.updateTime = now
  }

  /** 废弃所有进行中任务，返回被废弃列表（供调用方持久化） */
  abandonAllDoing(now: Date): ProcessTask[] {
    const abandoned: ProcessTask[] = []
    for (const t of this.tasks) {
      if (t.isDoing()) {
        t.abandon(now)
        abandoned.push(t)
      }
    }
    this.updateTime = now
    return abandoned
  }

  /** 流程完成 */
  finish(now: Date): void {
    this.state = InstanceState.Done
    this.updateTime = now
  }

  /** 驳回流程 */
  reject(now: Date): void {
    this.state = InstanceState.Reject
    this.updateTime = now
  }

  /** 撤回流程（issues/53 E25：withdraw 用 Withdraw(30)，与 reject 区分） */
  withdraw(now: Date): void {
    this.state = InstanceState.Withdraw
    this.updateTime = now
  }

  /** 追加变量 */
  addVariable(vars: Record<string, any>): void {
    Object.assign(this.variables, vars)
  }

  /** 获取进行中任务 */
  getDoingTasks(): ProcessTask[] {
    return this.tasks.filter(t => t.isDoing())
  }

  /** 获取已完成任务 */
  getDoneTasks(): ProcessTask[] {
    return this.tasks.filter(t => t.isFinished())
  }

  /** 所有任务是否都已完成（join 合并判断） */
  isAllTasksFinished(): boolean {
    return !this.tasks.some(t => t.isDoing())
  }

  /** 创建任务（子实体工厂）——performType：0 普通 / 1 会签（issues/52 E24 落库对齐 Java） */
  createTask(id: string, taskName: string, displayName: string, actor: string, operator: string, formKey: string, now: Date, performType = 0): ProcessTask {
    const task = new ProcessTask({
      id, processInstanceId: this.id,
      taskName, displayName, taskState: TaskState.Doing,
      actorId: '', actorIds: [actor],
      taskType: 0, performType, formKey,
      variables: {},
      createTime: now, updateTime: now, createUser: operator, updateUser: operator,
    })
    this.tasks.push(task)
    return task
  }
}

// ─── 子实体：ProcessTask ────────────────────────────────────────────────────────

export class ProcessTask {
  id!: string
  processInstanceId!: string
  taskName!: string
  displayName!: string
  taskType!: number
  performType!: number
  taskState!: TaskState
  actorId!: string
  actorIds!: string[]
  finishTime?: Date
  expireTime?: Date
  formKey!: string
  parentTaskId?: string
  variables!: Record<string, any>
  createTime!: Date
  createUser!: string
  updateTime!: Date
  updateUser!: string

  constructor(data: any) {
    Object.assign(this, data)
  }

  /** 完成任务 */
  finish(operator: string, vars: Record<string, any>, now: Date): void {
    this.taskState = TaskState.Done
    this.actorId = operator
    this.finishTime = now
    this.updateTime = now
    this.updateUser = operator
    this.variables = vars
  }

  /** 废弃任务 */
  abandon(now: Date): void {
    this.taskState = TaskState.Abandoned
    this.updateTime = now
  }

  /** 是否进行中 */
  isDoing(): boolean { return this.taskState === TaskState.Doing }

  /** 是否已完成 */
  isFinished(): boolean { return this.taskState === TaskState.Done }

  /** 操作人是否有权限处理 */
  isAllowed(operator: string): boolean {
    return this.actorIds.includes(operator)
  }
}

// ─── Clone Helpers（保留 class 原型）────────────────────────────────────────────

export function cloneInstance(inst: ProcessInstance): ProcessInstance {
  return Object.assign(Object.create(ProcessInstance.prototype), inst, {
    tasks: inst.tasks.map(cloneTask),
  })
}

export function cloneTask(task: ProcessTask): ProcessTask {
  return Object.assign(Object.create(ProcessTask.prototype), task)
}

export interface UserInfo {
  userId: string
  realName: string
  deptId?: string
  deptName?: string
  postId?: string
  postName?: string
}

// 抄送实例行数据（ccList 分页，v1.3.0，对齐 Java InstanceRow）
export interface CcInstanceRow {
  id: string
  parentId?: string
  defineId: string
  state: InstanceState
  parentNodeName: string
  businessNo: string
  operator: string
  expireTime?: Date
  variables: Record<string, any>
  createTime: Date
  createUser: string
  updateTime: Date
  updateUser: string
  defineName: string
  defineDisplayName: string
  defineVersion: number
}

// ─── 核心表分页行数据（v1.5.0，对齐 Java DefineRow/InstanceRow/TaskRow） ─────

export interface DefineRow {
  id: string
  name: string
  displayName: string
  type: string
  state: number
  version: number
  createTime: Date
  createUser: string
  updateTime: Date
  updateUser: string
}

export interface InstanceRow {
  id: string
  parentId?: string
  defineId: string
  state: InstanceState
  parentNodeName: string
  businessNo: string
  operator: string
  expireTime?: Date
  variables: Record<string, any>
  createTime: Date
  createUser: string
  updateTime: Date
  updateUser: string
  defineName: string
  defineDisplayName: string
  defineVersion: number
}

export interface TaskRow {
  id: string
  processInstanceId: string
  taskName: string
  displayName: string
  taskType: number
  performType: number
  taskState: TaskState
  operator: string
  finishTime?: Date
  expireTime?: Date
  formKey: string
  taskParentId?: string
  variables: Record<string, any>
  createTime: Date
  createUser: string
  updateTime: Date
  updateUser: string
  processDefineName: string
  processDefineDisplayName: string
  defineVersion: number
  instanceVariable: string
  instanceCreateTime: Date
}
