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

/**
 * 类型表全集（spec/02「类型键的三条义务」第 2 条 · issues/141 G4 立的判据本体）。
 *
 * 为什么要**具名成一个集合**，而不是让执行腿 `switch` 的 `default` 直接兜住：
 * `snaker:start` 也是表里的一档，但它在执行链上是**入口**（引擎从 start 的出边起步，start 自身
 * 正常不会被 `executeNode` 走到）。用"没人认领"当未知判据，会把"令牌真走到 start 上"这种拓扑病
 * 误报成"类型不在表里"——两个病得分别可诊断。义务 2 要的是**串 ∉ 表**那一判。
 *
 * ⚠️ 表里**没有** `snaker:subProcess`／`snaker:subprocess`：owner 2026-10-01 二拍「子流程暂不进
 * 契约面」（spec/02 义务 3 段），六栈不补这一档。设计器画出子流程节点时，本栈就靠 `executeNode`
 * 那条未知档日志把它**显式暴露**出来——那条裁定唯一的可诊断面就是这条日志。
 */
export const KnownNodeTypes: ReadonlySet<string> = new Set<string>([
  TypeStart, TypeEnd, TypeTask, TypeDecision, TypeFork, TypeJoin, TypeCustom,
])

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
  /** issues/115：转办留痕（processTask/transfer 用，不走 execute） */
  Transfer            = 7,
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

  /** 撤回流程（issues/53 E25：withdraw 用 Withdraw(30)，与 reject 区分）
   *
   *  issues/134 案 A（owner 2026-09-28 拍板 A）：撤回作用于**实例**时，实例状态不是
   *  10(进行中) 一律拒——守卫排在改写之前，被拒时实例 state 不被改写、不落库
   *  （改前对已办结(20)/已终止(40)的实例调撤回会静默改写成 30，已办列表与按状态
   *  聚合的统计口径凭空改历史且用户看不到任何报错）。
   *  内部码 20010009（八栈同码；本栈既有形状 20010007/20010008 同样是"码进注释、
   *  msg 只出固定中文文案"，见 engine.ts rollbackToParent）。出口按 issues/121 口径：
   *  门面吞内部码 ⇒ code=99999999 + msg 逐字 `流程实例非进行中，无法撤回`，不拼码。
   *  任务行层面既有保护（20/40 任务行不得被撤回改写）保持原样，实例级守卫排在它之前。 */
  withdraw(now: Date): void {
    const NOT_DOING = '流程实例非进行中，无法撤回'   // 内部码 20010009
    if (this.state !== InstanceState.Doing) throw new Error(NOT_DOING)
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

  /** 建单不变量（issues/121 P1）：本工厂必写 parentTaskId（发起 execution 无当前任务时传字符 0）
   * 与行级 isFirstTaskNode；两参无默认值，漏传即编译不过，不留静默漏写路径。
   *
   * 创建任务（子实体工厂）——performType：0 普通 / 1 会签（issues/52 E24 落库对齐 Java） */
  createTask(id: string, taskName: string, displayName: string, actor: string, operator: string, formKey: string, now: Date, parentId: string, isFirst: boolean, performType = 0): ProcessTask {
    const task = new ProcessTask({
      id, processInstanceId: this.id,
      taskName, displayName, taskState: TaskState.Doing,
      actorId: '', actorIds: [actor],
      taskType: 0, performType, formKey, parentTaskId: parentId,
      variables: { isFirstTaskNode: isFirst },
      createTime: now, updateTime: now, createUser: operator, updateUser: operator,
    })
    this.tasks.push(task)
    return task
  }

  /**
   * 记录类历史行工厂（issues/142 A 批 · spec 02-flow-definition.md §6.1/§6.2，owner 2026-09-29/09-30 两次拍）
   *
   * 形状基准＝jeeflow-java `ProcessInstance.createHistoryTask`（domain/ProcessInstance.java:425）
   * ＋ python `create_history_task`（jeeflow/model.py:223）：`taskState=20(DONE)`、
   * 参与者＝`[operator]`（**留痕主体，不是待办**——java 那侧是 `Collections.singletonList(operator)`）、
   * 无 formKey、无会签字段、`finishTime` 已落；建单不变量（`parentTaskId` ＋ 行级 `isFirstTaskNode`）
   * 与 `createTask` 同规格适用（issues/121 P1，java 那边也是同一句注释）。
   *
   * ⚠️ 这一支存在的理由：记录类节点（`snaker:custom`）**没有参与者是正常形态**，既不许按任务类
   * 建 DOING 行（§6.1 禁止形状①），也不许"兜底把行挂给当前操作人"伪造一条他不该收到的待办
   * （禁止形状②——行是 DONE ⇒ 谁也办不动，天然不在待办里），更不许直接跳过节点丢留痕（禁止形状③）。
   * 调用方必须把返回的行**真落库**（`repo.saveTask`）——§6.2 第 1 条：只在聚合 `tasks` 里 append
   * 不算做到，java/c# 现读正是栽在这条上的（基准自身的洞，本栈不照抄）。 */
  createHistoryTask(id: string, taskName: string, displayName: string, operator: string, now: Date, parentId: string, isFirst: boolean): ProcessTask {
    const task = new ProcessTask({
      id, processInstanceId: this.id,
      taskName, displayName, taskState: TaskState.Done,
      actorId: operator ?? '', actorIds: operator ? [operator] : [],
      taskType: 0, performType: 0, formKey: '', parentTaskId: parentId,
      variables: { isFirstTaskNode: isFirst },
      finishTime: now,
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

  /** 随实例撤回任务（区别于 abandon：撤回是发起人主动收回，废弃是引擎清理） */
  withdraw(now: Date): void {
    this.taskState = TaskState.Withdraw
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
    tasks: (inst.tasks ?? []).map(cloneTask),
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
