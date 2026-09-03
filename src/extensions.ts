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
  // issues/102：抄送知会（对齐 Java CC_CREATE / Go EventCCCreate / Python CC_CREATE / PHP CC_CREATE；
  // 4 号位是活码 TaskComplete，0/1/2/3/4 不重排——码值契约 Go/Node=5）
  CcCreate      = 5,
}

export interface ProcessEvent {
  type: EventType
  instanceId: string
  taskId?: string
  nodeId?: string
  operator: string
  /** 抄送人 id 直传事件体，监听器免反查 cc 表（issues/102；对齐 Java ccActorId / Go CcActorID） */
  ccActorId?: string
}

export type ProcessEventListener = (event: ProcessEvent) => void | Promise<void>

export interface EngineExtensions {
  interceptors?: FlowInterceptor[]
  /** 定义级拦截器注册表（issue 34）：名字 → 实例；流程定义顶层 postInterceptors 按名解析 */
  interceptorRegistry?: Record<string, FlowInterceptor>
  assignmentHandler?: AssignmentHandler
  decisionHandler?: DecisionHandler
  listeners?: ProcessEventListener[]
}
