import type { FlowNode, ProcessInstance } from './model.js'

/** 参与者指派处理器接口——对标 Java AssignmentHandler */
export interface IAssignmentHandler {
  /** 返回参与者列表（operator: 当前任务操作人，issues/16 对齐 Java Execution.getOperator） */
  assign(node: FlowNode, inst: ProcessInstance, operator: string): string[] | Promise<string[]>
}

/** 决策处理器接口——对标 Java DecisionHandler */
export interface IDecisionHandler {
  decide(node: FlowNode, inst: ProcessInstance, vars: Record<string, any>): string | Promise<string>
}

/** 处理器类型名（对齐 Java/go/python HandlerMeta.type，四语言通用） */
export type HandlerType = 'AssignmentHandler' | 'CandidateHandler' | 'FlowInterceptor' | 'DecisionHandler'

/** 处理器元数据（v1.4.0，SPI 实现清单字典源） */
export interface HandlerMeta {
  /** 处理器类型（内置 AssignmentHandler 元数据自动携带；老数据缺省按 AssignmentHandler 归类） */
  type?: HandlerType
  /** 处理器标识：节点配置的 handlerName（与字典 value 一致） */
  name: string
  /** 显示名（字典 label） */
  displayName?: string
  /** 排序（小在前） */
  order?: number
  /** 分组（拦截器 pre/post 显式声明；其余可为空） */
  group?: string
}

/** 内置通用 AssignmentHandler 元数据（v1.6.0 issues/16，注册名与 Java 类全限定名一致，四语言通用） */
export const BUILTIN_ASSIGNMENT_METAS: HandlerMeta[] = [
  { type: 'AssignmentHandler', name: 'com.mldong.jeeflow.interceptor.impl.OperatorAssignmentHandler', displayName: '流程发起人', order: -9999 },
  { type: 'AssignmentHandler', name: 'com.mldong.jeeflow.interceptor.impl.OrgUserAssignmentHandlers$ApplicantDeptLeaderAssignmentHandler', displayName: '发起人所属部门经理', order: 10 },
  { type: 'AssignmentHandler', name: 'com.mldong.jeeflow.interceptor.impl.OrgUserAssignmentHandlers$ApplicantDeptMainLeaderAssignmentHandler', displayName: '发起人所属部门分管领导', order: 20 },
  { type: 'AssignmentHandler', name: 'com.mldong.jeeflow.interceptor.impl.OrgUserAssignmentHandlers$DeptLeaderAssignmentHandler', displayName: '当前用户所属部门经理', order: 30 },
  { type: 'AssignmentHandler', name: 'com.mldong.jeeflow.interceptor.impl.OrgUserAssignmentHandlers$DeptMainLeaderAssignmentHandler', displayName: '当前用户所属部门分管领导', order: 40 },
  { type: 'AssignmentHandler', name: 'com.mldong.jeeflow.interceptor.impl.FormFieldAssigneeHandler', displayName: '根据表单字段值分配参与者', order: 50 },
  { type: 'AssignmentHandler', name: 'com.mldong.jeeflow.interceptor.impl.OrgUserAssignmentHandlers$TaskRoleAssigneeHandler', displayName: '根据任务节点唯一编码关联角色分配参与者', order: 60 },
]

/** 处理器注册表——按名称注册/解析 + 元数据清单（对标 Spring IoC / Java HandlerRegistry） */
export class HandlerRegistry {
  private assignments = new Map<string, IAssignmentHandler>()
  private decisions   = new Map<string, IDecisionHandler>()
  private metas       = new Map<string, HandlerMeta>()

  /** 构造即内置 7 个通用 AssignmentHandler 元数据（v1.6.0 issues/16，注册名与 Java 类全限定名一致） */
  constructor() {
    for (const meta of BUILTIN_ASSIGNMENT_METAS) {
      this.metas.set(meta.name, meta)
    }
  }

  registerAssignment(name: string, handler: IAssignmentHandler, meta?: Omit<HandlerMeta, 'name' | 'type'>) {
    this.assignments.set(name, handler)
    if (meta) this.metas.set(name, { type: 'AssignmentHandler', name, ...meta })
  }

  registerDecision(name: string, handler: IDecisionHandler, meta?: Omit<HandlerMeta, 'name' | 'type'>) {
    this.decisions.set(name, handler)
    if (meta) this.metas.set(name, { type: 'DecisionHandler', name, ...meta })
  }

  /** 注册处理器元数据（不绑定运行时实现，对齐 Java HandlerRegistry.register；
   *  拦截器/候选类清单等无运行时注册表的类型用） */
  registerMeta(type: HandlerType, meta: Omit<HandlerMeta, 'type'>) {
    this.metas.set(meta.name, { type, ...meta })
  }

  resolveAssignment(name: string): IAssignmentHandler | undefined {
    return this.assignments.get(name)
  }

  resolveDecision(name: string): IDecisionHandler | undefined {
    return this.decisions.get(name)
  }

  // ── SPI 实现清单（v1.4.0）──

  /** 按处理器类型列出可用实现的元数据（按 order 升序；
   *  AssignmentHandler/DecisionHandler 并集运行时注册名，其余类型只列显式元数据） */
  listHandlers(typeName: HandlerType): HandlerMeta[] {
    const names = new Set<string>()
    if (typeName === 'AssignmentHandler') {
      for (const n of this.assignments.keys()) names.add(n)
    } else if (typeName === 'DecisionHandler') {
      for (const n of this.decisions.keys()) names.add(n)
    }
    for (const [n, m] of this.metas) {
      // 老数据无 type 时按 AssignmentHandler 归类（与历史 listHandlers 行为一致）
      if ((m.type ?? 'AssignmentHandler') === typeName) names.add(n)
    }
    return [...names]
      .map(n => this.metas.get(n) ?? { name: n })
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  }

  /** 按处理器类型 + 分组列出（拦截器 pre/post） */
  listHandlersGroup(typeName: HandlerType, group: string): HandlerMeta[] {
    return this.listHandlers(typeName).filter(m => m.group === group)
  }

  /** 已注册的处理器名称清单（含未带元数据的） */
  listHandlerNames(): string[] {
    return [...this.assignments.keys(), ...this.decisions.keys()]
  }
}
