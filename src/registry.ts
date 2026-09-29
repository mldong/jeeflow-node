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

/**
 * 记录类节点（`snaker:custom`）处理器接口 —— issues/142 A 批 · spec 02-flow-definition.md §6.2 第 2 条。
 *
 * 注册键＝流程定义里 `properties.clazz` 的**原样字符串**（如夹具
 * `flows/08-custom-node.json` 的 `com.mldong.jeeflow.test.TestCustomHandler`）。
 * java 那边是 `Class.forName(clazz).newInstance()` 的反射按名实例化；TS 没有可依托的反射语义，
 * 共享夹具里的 JVM 类名在 node 永远实例化不到，故与 **c#(`Context.CustomHandlers`) /
 * python(`HandlerRegistry.register_custom`) 同策**：集成方按名注册实例，引擎按名解析后调用。
 *
 * 返回值非 `undefined` 时由引擎写进执行变量，键＝节点 `properties.val`（缺省 `custom_return_val`），
 * 对齐 java `CustomParser.java:20-22` ＋ `CustomModel.java:46-48`。
 * 可同步可异步（与 `IAssignmentHandler.assign` 一样两侧都吃）。
 */
export interface ICustomHandler {
  handle(node: FlowNode, inst: ProcessInstance, operator: string, vars: Record<string, any>): any | Promise<any>
}

/** 处理器类型名（对齐 Java/go/python HandlerMeta.type，四语言通用） */
export type HandlerType = 'AssignmentHandler' | 'CandidateHandler' | 'FlowInterceptor' | 'DecisionHandler' | 'CustomHandler'

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
  private customs     = new Map<string, ICustomHandler>()
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

  /**
   * 注册记录类节点处理器（issues/142 A 批 · spec 02 §6.2 第 2 条）。
   * `name` 必须是流程定义 `properties.clazz` 的**原样字符串**（引擎按名解析，不做反射、不做包名裁剪）。
   */
  registerCustom(name: string, handler: ICustomHandler, meta?: Omit<HandlerMeta, 'name' | 'type'>) {
    this.customs.set(name, handler)
    if (meta) this.metas.set(name, { type: 'CustomHandler', name, ...meta })
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

  /**
   * 按 `clazz` 原样串解析记录类节点处理器；空名/未注册 ⇒ `undefined`
   * （引擎侧分档记日志后照常落历史行并续流，**不抛错** —— spec 02 §6.2 第 2 条）。 */
  resolveCustom(name: string): ICustomHandler | undefined {
    return name ? this.customs.get(name) : undefined
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
    } else if (typeName === 'CustomHandler') {
      for (const n of this.customs.keys()) names.add(n)
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
    return [...this.assignments.keys(), ...this.decisions.keys(), ...this.customs.keys()]
  }
}
