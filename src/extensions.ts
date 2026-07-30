import type { FlowNode, ProcessInstance } from './model.js'

/** 流程拦截器——对标 Java FlowInterceptor */
export interface FlowInterceptor {
  preHandle(node: FlowNode, inst: ProcessInstance): boolean | Promise<boolean>
  postHandle(node: FlowNode, inst: ProcessInstance): void | Promise<void>
  order: number
}

/**
 * 动态参与者指派——对标 Java AssignmentHandler.assign
 * @param handlerName 节点配置的 assignmentHandler 名（如 "com.xxx.MyHandler"）
 * @returns 参与者 ID 列表（空数组表示不处理）
 */
export type AssignmentHandler = (handlerName: string, node: FlowNode, inst: ProcessInstance) => string[] | Promise<string[]>

/**
 * 自定义决策处理器——对标 Java DecisionHandler
 * @param handlerName 节点配置的 decisionHandler 名
 * @returns 选中的分支边 ID（空字符串表示不处理）
 */
export type DecisionHandler = (handlerName: string, node: FlowNode, inst: ProcessInstance, vars: Record<string, any>) => string | Promise<string>

export enum EventType {
  ProcessStart  = 0,
  ProcessFinish = 1,
  ProcessReject = 2,
  TaskCreate    = 3,
  TaskComplete  = 4,
}

export interface ProcessEvent {
  type: EventType
  instanceId: number
  taskId?: number
  nodeId?: string
  operator: string
}

export type ProcessEventListener = (event: ProcessEvent) => void | Promise<void>

export interface EngineExtensions {
  interceptors?: FlowInterceptor[]
  assignmentHandler?: AssignmentHandler
  decisionHandler?: DecisionHandler
  listeners?: ProcessEventListener[]
}
