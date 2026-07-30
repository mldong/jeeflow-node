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

export interface ProcessDefine {
  id: number
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

export enum InstanceState {
  Doing  = 10,
  Done   = 20,
  Reject = 45,
}

export enum TaskState {
  Doing     = 10,
  Done      = 20,
  Abandoned = 99,
}

export interface ProcessInstance {
  id: number
  parentId?: number
  defineId: number
  state: InstanceState
  parentNodeName: string
  businessNo: string
  operator: string
  expireTime?: Date
  variables: Record<string, any>
  tasks: ProcessTask[]
  createTime: Date
  createUser: string
  updateTime: Date
  updateUser: string
}

export interface ProcessTask {
  id: number
  processInstanceId: number
  taskName: string
  displayName: string
  taskType: number
  performType: number
  taskState: TaskState
  actorId: string
  actorIds: string[]
  finishTime?: Date
  expireTime?: Date
  formKey: string
  parentTaskId?: number
  variables: Record<string, any>
  createTime: Date
  createUser: string
  updateTime: Date
  updateUser: string
}

export interface UserInfo {
  userId: string
  realName: string
  deptId?: string
  deptName?: string
  postId?: string
  postName?: string
}
