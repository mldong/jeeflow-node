import type { FlowNode, ProcessInstance } from './model.js'

/** 参与者指派处理器接口——对标 Java AssignmentHandler */
export interface IAssignmentHandler {
  assign(node: FlowNode, inst: ProcessInstance): string[] | Promise<string[]>
}

/** 决策处理器接口——对标 Java DecisionHandler */
export interface IDecisionHandler {
  decide(node: FlowNode, inst: ProcessInstance, vars: Record<string, any>): string | Promise<string>
}

/** 处理器元数据（v1.4.0，SPI 实现清单字典源） */
export interface HandlerMeta {
  /** 处理器标识：节点配置的 handlerName（与字典 value 一致） */
  name: string
  /** 显示名（字典 label） */
  displayName?: string
  /** 排序（小在前） */
  order?: number
  /** 分组（拦截器 pre/post 显式声明；其余可为空） */
  group?: string
}

/** 处理器注册表——按名称注册/解析 + 元数据清单（对标 Spring IoC / Java HandlerRegistry） */
export class HandlerRegistry {
  private assignments = new Map<string, IAssignmentHandler>()
  private decisions   = new Map<string, IDecisionHandler>()
  private metas       = new Map<string, HandlerMeta>()

  registerAssignment(name: string, handler: IAssignmentHandler, meta?: Omit<HandlerMeta, 'name'>) {
    this.assignments.set(name, handler)
    if (meta) this.metas.set(name, { name, ...meta })
  }

  registerDecision(name: string, handler: IDecisionHandler, meta?: Omit<HandlerMeta, 'name'>) {
    this.decisions.set(name, handler)
    if (meta) this.metas.set(name, { name, ...meta })
  }

  resolveAssignment(name: string): IAssignmentHandler | undefined {
    return this.assignments.get(name)
  }

  resolveDecision(name: string): IDecisionHandler | undefined {
    return this.decisions.get(name)
  }

  // ── SPI 实现清单（v1.4.0）──

  /** 按处理器类型列出可用实现的元数据（typeName: AssignmentHandler / DecisionHandler，按 order 升序） */
  listHandlers(typeName: 'AssignmentHandler' | 'DecisionHandler'): HandlerMeta[] {
    const names = typeName === 'AssignmentHandler'
      ? [...this.assignments.keys()]
      : [...this.decisions.keys()]
    return names
      .map(n => this.metas.get(n) ?? { name: n })
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  }

  /** 按处理器类型 + 分组列出（拦截器 pre/post） */
  listHandlersGroup(typeName: 'AssignmentHandler' | 'DecisionHandler', group: string): HandlerMeta[] {
    return this.listHandlers(typeName).filter(m => m.group === group)
  }

  /** 已注册的处理器名称清单（含未带元数据的） */
  listHandlerNames(): string[] {
    return [...this.assignments.keys(), ...this.decisions.keys()]
  }
}
