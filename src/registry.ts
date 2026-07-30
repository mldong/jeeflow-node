import type { FlowNode, ProcessInstance } from './model.js'

/** 参与者指派处理器接口——对标 Java AssignmentHandler */
export interface IAssignmentHandler {
  assign(node: FlowNode, inst: ProcessInstance): string[] | Promise<string[]>
}

/** 决策处理器接口——对标 Java DecisionHandler */
export interface IDecisionHandler {
  decide(node: FlowNode, inst: ProcessInstance, vars: Record<string, any>): string | Promise<string>
}

/** 处理器注册表——按名称注册/解析（对标 Spring IoC） */
export class HandlerRegistry {
  private assignments = new Map<string, IAssignmentHandler>()
  private decisions   = new Map<string, IDecisionHandler>()

  registerAssignment(name: string, handler: IAssignmentHandler) {
    this.assignments.set(name, handler)
  }

  registerDecision(name: string, handler: IDecisionHandler) {
    this.decisions.set(name, handler)
  }

  resolveAssignment(name: string): IAssignmentHandler | undefined {
    return this.assignments.get(name)
  }

  resolveDecision(name: string): IDecisionHandler | undefined {
    return this.decisions.get(name)
  }
}
