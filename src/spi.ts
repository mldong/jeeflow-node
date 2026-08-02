import type { ProcessDefine, ProcessInstance, ProcessTask, UserInfo } from './model.js'

export interface ProcessRepository {
  findDefineById(id: number): Promise<ProcessDefine | null>
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
