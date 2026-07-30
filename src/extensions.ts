import type { FlowNode, ProcessInstance } from './model.js'

// ─── Interceptor ───────────────────────────────────────────────────────────────

/** 流程拦截器——对标 Java FlowInterceptor */
export interface FlowInterceptor {
  /** 节点执行前调用，返回 false 跳过该节点 */
  preHandle(node: FlowNode, inst: ProcessInstance): boolean | Promise<boolean>
  /** 节点执行后调用 */
  postHandle(node: FlowNode, inst: ProcessInstance): void | Promise<void>
  /** 排序，越小越先 */
  order: number
}

// ─── Assignment ────────────────────────────────────────────────────────────────

/** 动态参与者指派——对标 Java AssignmentHandler.assign */
export type AssignmentHandler = (node: FlowNode, inst: ProcessInstance) => string[] | Promise<string[]>

// ─── Decision ──────────────────────────────────────────────────────────────────

/** 自定义决策处理器——对标 Java DecisionHandler */
export type DecisionHandler = (node: FlowNode, inst: ProcessInstance, vars: Record<string, any>) => string | Promise<string>

// ─── Event ─────────────────────────────────────────────────────────────────────

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

// ─── Extensions ────────────────────────────────────────────────────────────────

export interface EngineExtensions {
  interceptors?: FlowInterceptor[]
  assignmentHandler?: AssignmentHandler
  decisionHandler?: DecisionHandler
  listeners?: ProcessEventListener[]
}
