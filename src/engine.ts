import {
  type FlowModel, type FlowNode,
  TypeStart, TypeEnd, TypeTask, TypeDecision, TypeFork, TypeJoin, TypeCustom,
  ProcessInstance, type ProcessTask, type ProcessDefine,
  InstanceState, TaskState, SubmitType,
} from './model.js'
import type { ProcessRepository, UserProvider, IDGenerator, ExpressionEvaluator } from './spi.js'
import { type EngineExtensions, type FlowInterceptor, type AssignmentHandler, type DecisionHandler, type ProcessEventListener, EventType, type ProcessEvent } from './extensions.js'
import { HandlerRegistry } from './registry.js'

export const KeySubmitType   = 'submitType'
export const KeyBusinessNo   = 'BUSINESS_NO'
export const KeyUserID       = 'u_userId'
export const KeyRealName     = 'u_realName'
export const KeyDeptID       = 'u_deptId'
export const KeyDeptName     = 'u_deptName'
export const KeyPostID       = 'u_postId'
export const KeyPostName     = 'u_postName'
// v1.0.1：下一节点处理人（对齐 boot3 tf_nextNodeOperator）
export const KeyNextNodeOperator = 'tf_nextNodeOperator'
// v1.6.0：流程启动时预指派人（对齐 boot3 f_nextNodeOperator）——startAndExecute 时转换为 tf_
export const KeyProcessStartNextNodeOperator = 'f_nextNodeOperator'
// v1.0.1：系统代执行 / 超级管理员（对齐 boot3 FlowConst）
export const KeyAutoExecute = 'flow.auto'
export const KeyAdminID     = 'flow.admin'

export interface Engine {
  startProcessInstanceById(defineId: string, operator: string, args?: Record<string, any>): Promise<ProcessInstance>
  executeProcessTask(taskId: string, operator: string, args?: Record<string, any>): Promise<ProcessInstance>
  executeAndJumpToEnd(taskId: string, operator: string, args?: Record<string, any>): Promise<ProcessInstance>
  executeAndJumpTask(taskId: string, operator: string, args: Record<string, any>, targetTaskName?: string): Promise<ProcessInstance>
  executeAndJumpToFirstTaskNode(taskId: string, operator: string, args?: Record<string, any>): Promise<ProcessInstance>
}

export class EngineImpl implements Engine {
  private ext?: EngineExtensions
  private registry?: HandlerRegistry

  constructor(
    private repo: ProcessRepository,
    private userProv?: UserProvider,
    private idGen?: IDGenerator,
    private exprEval?: ExpressionEvaluator,
  ) {}

  setExtensions(ext: EngineExtensions) {
    this.ext = ext
    this.interceptorCache = new Map()
  }
  setRegistry(reg: HandlerRegistry) { this.registry = reg }

  private interceptorCache = new Map<string, FlowInterceptor[]>()

  /** 定义级拦截器解析（issue 34，对齐 Java 模型级 postInterceptors）：
   *  流程定义顶层 postInterceptors 声明 → 按名从 interceptorRegistry 取（未声明该流程不触发）；
   *  未声明 → 回落引擎级列表（向后兼容）。结果按 defineId 缓存。 */
  private async resolveInterceptors(inst: ProcessInstance): Promise<FlowInterceptor[]> {
    if (!this.ext) return []
    const defineId = inst.defineId
    if (defineId == null) return this.ext.interceptors ?? []
    const cached = this.interceptorCache.get(defineId)
    if (cached) return cached
    let list = this.ext.interceptors ?? []
    try {
      const def = await this.repo.findDefineById(defineId)
      if (def) {
        const content = typeof def.content === 'string' ? def.content : new TextDecoder().decode(def.content as Uint8Array)
        const meta = JSON.parse(content)
        const declared = String(meta.postInterceptors ?? '').trim()
        if (declared) {
          list = []
          for (const name of declared.split(',').map(n => n.trim())) {
            const ic = this.ext.interceptorRegistry?.[name]
            if (name && ic) list.push(ic)
          }
        }
      }
    } catch { /* 解析失败回落引擎级 */ }
    this.interceptorCache.set(defineId, list)
    return list
  }

  private async firePre(node: FlowNode, inst: ProcessInstance): Promise<boolean> {
    if (!this.ext?.interceptors && !this.ext?.interceptorRegistry) return true
    const list = await this.resolveInterceptors(inst)
    for (const ic of [...list].sort((a, b) => a.order - b.order))
      if (!(await ic.preHandle(node, inst))) return false
    return true
  }
  /** 表达式求值（v1.5.0，门面 highLight 决策分支过滤用） */
  async evalExpr(expr: string, vars: Record<string, any>): Promise<any> {
    if (!this.exprEval) throw new Error('ExpressionEvaluator 未配置')
    return this.exprEval.eval(expr, vars)
  }

  private async firePost(node: FlowNode, inst: ProcessInstance) {
    if (!this.ext?.interceptors && !this.ext?.interceptorRegistry) return
    for (const ic of await this.resolveInterceptors(inst)) await ic.postHandle(node, inst)
  }
  private async fireEvent(evt: ProcessEvent) {
    if (!this.ext?.listeners) return
    for (const l of this.ext.listeners) await l(evt)
  }

  // ─── Start ─────────────────────────────────────────────────────────────────

  async startProcessInstanceById(defineId: string, operator: string, args: Record<string, any> = {}): Promise<ProcessInstance> {
    const def = await this.repo.findDefineById(defineId)
    if (!def) throw new Error(`define not found: ${defineId}`)
    const content = typeof def.content === 'string' ? def.content : new TextDecoder().decode(def.content as Uint8Array)
    const flow: FlowModel = JSON.parse(content)

    const vars = { ...args }
    await this.addUserInfo(operator, vars)

    const now = new Date()
    // 聚合根工厂创建实例
    const inst = ProcessInstance.create(this.nextId(), defineId, operator, vars, now)
    await this.repo.saveInstance(inst)
    await this.fireEvent({ type: EventType.ProcessStart, instanceId: inst.id, operator })

    const startNode = findNodeByType(flow, TypeStart)
    if (!startNode) throw new Error('no start node')

    for (const node of followEdges(flow, startNode.id)) {
      await this.executeNode(flow, inst, node, operator, vars)
    }
    return (await this.repo.findInstanceById(inst.id))!
  }

  // ─── Execute ───────────────────────────────────────────────────────────────

  async executeProcessTask(taskId: string, operator: string, args: Record<string, any> = {}): Promise<ProcessInstance> {
    const { task, inst } = await this.loadAndCheck(taskId, operator)
    // issues/26：办理提交的 f_ 字段按任务节点字段权限过滤（只读/隐藏不入变量）——
    // 被拒值无法经流程变量落到下游节点写入，上游只读声明不可被绕过
    const def = await this.repo.findDefineById(inst.defineId)
    const flow: FlowModel = JSON.parse(typeof def!.content === 'string' ? def!.content : new TextDecoder().decode(def!.content as Uint8Array))
    args = filterFieldByPerm(args, findNode(flow, task.taskName))
    const vars = { ...inst.variables, ...task.variables, ...args }
    await this.addUserInfo(operator, vars)

    const now = new Date()
    // 聚合根：完成任务（子实体状态转换 + 实例变量合并）
    inst.completeTask(task, operator, vars, now)
    await this.repo.updateTask(task)
    // v1.0.1：updateInstance 级联持久化依赖聚合内任务副本为最新状态，
    // completeTask 改的是外部任务对象，需同步回聚合根
    syncTaskToAggregate(inst, task)
    await this.fireEvent({ type: EventType.TaskComplete, instanceId: inst.id, taskId: task.id, nodeId: task.taskName, operator })

    inst.variables = vars
    await this.repo.updateInstance(inst)

    const curNode = findNode(flow, task.taskName)
    if (curNode) {
      // 1.8.0：任务完成节点自身的后置拦截器（SYNC 同步演进——任务节点推进更新状态/字段）。
      // createTask 不再触发（引擎语义修正），此处为完成任务节点的唯一触发点
      await this.firePost(curNode, inst)
      const ct = curNode.properties?.countersignType as string | undefined
      if (ct === 'SEQUENTIAL') {
        const doing = await this.repo.findDoingTasks(inst.id)
        if (doing.length === 0) {
          const [actors, lc] = getCsState(vars, curNode.id)
          if (actors && lc + 1 < actors.length) {
            // 聚合根：创建串行会签下一步任务
            const nt = inst.createTask(this.nextId(), curNode.id, curNode.text.value, actors[lc + 1], operator, curNode.properties?.form ?? '', now)
            nt.variables = {
              [`nrOfInstances_${curNode.id}`]: actors.length,
              [`loopCounter_${curNode.id}`]: lc + 1,
              [`operatorList_${curNode.id}`]: actors,
            }
            await this.repo.saveTask(nt)
            return (await this.repo.findInstanceById(inst.id))!
          }
        } else {
          return (await this.repo.findInstanceById(inst.id))!
        }
      }
      if (ct === 'PARALLEL' || ct?.startsWith('RATIO')) {
        const doing = await this.repo.findDoingTasks(inst.id)
        if (doing.length > 0) return (await this.repo.findInstanceById(inst.id))!
      }
      for (const node of followEdges(flow, curNode.id)) {
        // 统一走 executeNode：结束节点也经节点执行链（拦截器/事件完整触发），
        // executeNode 内部 TypeEnd 分支完成聚合根 finish + 事件发布
        await this.executeNode(flow, inst, node, operator, vars)
      }
    }
    return (await this.repo.findInstanceById(inst.id))!
  }

  // ─── Reject ────────────────────────────────────────────────────────────────

  async executeAndJumpToEnd(taskId: string, operator: string, args: Record<string, any> = {}): Promise<ProcessInstance> {
    const { task, inst } = await this.loadAndCheck(taskId, operator)
    const now = new Date()
    // 聚合根：废弃所有进行中任务
    for (const t of inst.abandonAllDoing(now)) await this.repo.updateTask(t)
    // 子实体：完成任务
    task.finish(operator, task.variables, now)
    await this.repo.updateTask(task)
    // v1.0.1：同步回聚合根，避免 updateInstance 级联把任务写回旧状态
    syncTaskToAggregate(inst, task)
    // 聚合根：驳回
    inst.reject(now)
    await this.repo.updateInstance(inst)
    await this.fireEvent({ type: EventType.ProcessReject, instanceId: inst.id, taskId, operator })
    return inst
  }

  // ─── Jump ──────────────────────────────────────────────────────────────────

  async executeAndJumpTask(taskId: string, operator: string, args: Record<string, any> = {}, targetTaskName?: string): Promise<ProcessInstance> {
    const { task, inst } = await this.loadAndCheck(taskId, operator)
    const now = new Date()
    // 聚合根：废弃所有进行中任务
    for (const t of inst.abandonAllDoing(now)) await this.repo.updateTask(t)
    // 子实体：完成任务
    task.finish(operator, task.variables, now)
    await this.repo.updateTask(task)

    if (targetTaskName) {
      const def = await this.repo.findDefineById(inst.defineId)
      const flow: FlowModel = JSON.parse(typeof def!.content === 'string' ? def!.content : new TextDecoder().decode(def!.content as Uint8Array))
      const target = findNode(flow, targetTaskName)
      if (target) await this.executeNode(flow, inst, target, operator, inst.variables)
    }
    return inst
  }

  // ─── Jump To First Task（退回发起人，boot2 ROLLBACK_TO_OPERATOR=6）────────────

  async executeAndJumpToFirstTaskNode(taskId: string, operator: string, args: Record<string, any> = {}): Promise<ProcessInstance> {
    const { task, inst } = await this.loadAndCheck(taskId, operator)
    const now = new Date()
    // 聚合根：废弃所有进行中任务
    for (const t of inst.abandonAllDoing(now)) await this.repo.updateTask(t)
    // 子实体：完成任务
    task.finish(operator, task.variables, now)
    await this.repo.updateTask(task)
    // 找到第一个任务节点，强制参与者为发起人，重新执行
    const def = await this.repo.findDefineById(inst.defineId)
    const flow: FlowModel = JSON.parse(typeof def!.content === 'string' ? def!.content : new TextDecoder().decode(def!.content as Uint8Array))
    const startNode = findNodeByType(flow, TypeStart)
    if (startNode) {
      for (const node of followEdges(flow, startNode.id)) {
        if (node.type === TypeTask || node.type === TypeCustom) {
          node.properties = node.properties ?? {}
          node.properties.assignee = inst.operator
          await this.executeNode(flow, inst, node, operator, inst.variables)
          break
        }
      }
    }
    return inst
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async loadAndCheck(taskId: string, operator: string) {
    const task = await this.repo.findTaskById(taskId)
    if (!task) throw new Error(`task not found: ${taskId}`)
    if (task.taskState !== TaskState.Doing) throw new Error(`task not doing`)
    if (!this.isAllowed(task, operator)) throw new Error(`operator ${operator} not allowed`)
    const inst = await this.repo.findInstanceById(task.processInstanceId)
    if (!inst) throw new Error(`instance not found`)
    return { task, inst }
  }

  private async executeNode(flow: FlowModel, inst: ProcessInstance, node: FlowNode, operator: string, vars: Record<string, any>): Promise<void> {
    // 任务创建（对齐 Java CreateTaskHandler：不触发节点拦截器——创建任务 ≠ 节点执行完成；
    // 任务完成的拦截器由 executeProcessTask 显式触发，1.8.0 SYNC 同步演进）
    if (node.type === TypeTask || node.type === TypeCustom) {
      await this.createTask(node, inst, operator, vars)
      return
    }
    if (!(await this.firePre(node, inst))) return
    try {
    switch (node.type) {
      case TypeDecision:
        return this.evaluateDecision(flow, inst, node, operator, vars)
      case TypeFork:
        for (const n of followEdges(flow, node.id)) await this.executeNode(flow, inst, n, operator, vars)
        return
      case TypeJoin: {
        const doing = await this.repo.findDoingTasks(inst.id)
        if (doing.length === 0)
          for (const n of followEdges(flow, node.id)) await this.executeNode(flow, inst, n, operator, vars)
        return
      }
      case TypeEnd: {
        // 对齐 Java EndProcessHandler：submitType=REJECT → reject，否则 finish
        const submitType = inst.variables[KeySubmitType]
        if (submitType != null && Number(submitType) === SubmitType.Reject) {
          inst.reject(new Date())
        } else {
          inst.finish(new Date())
        }
        inst.variables = vars
        await this.repo.updateInstance(inst)
        await this.fireEvent({ type: EventType.ProcessFinish, instanceId: inst.id, operator })
        return
      }
    }
    } finally { await this.firePost(node, inst) }
  }

  private async evaluateDecision(flow: FlowModel, inst: ProcessInstance, node: FlowNode, operator: string, vars: Record<string, any>): Promise<void> {
    // 自定义决策（Registry 优先）
    if (this.registry) {
      const handlerName = (node.properties?.decisionHandler as string) ?? ''
      if (handlerName) {
        const h = this.registry.resolveDecision(handlerName)
        if (h) {
          const branchId = await h.decide(node, inst, vars)
          if (branchId) {
            for (const edge of flow.edges) {
              if (edge.id === branchId) {
                const target = findNode(flow, edge.targetNodeId)
                if (target) return this.executeNode(flow, inst, target, operator, vars)
              }
            }
          }
        }
      }
    }
    // 自定义决策（Extensions 兼容）
    if (this.ext?.decisionHandler) {
      const handlerName = (node.properties?.decisionHandler as string) ?? ''
      const branchId = await this.ext.decisionHandler(handlerName, node, inst, vars)
      if (branchId) {
        for (const edge of flow.edges) {
          if (edge.id === branchId) {
            const target = findNode(flow, edge.targetNodeId)
            if (target) return this.executeNode(flow, inst, target, operator, vars)
          }
        }
      }
    }
    // 表达式决策
    for (const edge of flow.edges) {
      if (edge.sourceNodeId !== node.id) continue
      const expr = edge.properties?.expr as string | undefined
      if (!expr) {
        const target = findNode(flow, edge.targetNodeId)
        if (target) return this.executeNode(flow, inst, target, operator, vars)
        return
      }
      if (this.exprEval) {
        const result = await this.exprEval.eval(expr, vars)
        if (isTruthy(result)) {
          const target = findNode(flow, edge.targetNodeId)
          if (target) return this.executeNode(flow, inst, target, operator, vars)
          return
        }
      }
    }
  }

  private async createTask(node: FlowNode, inst: ProcessInstance, operator: string, vars: Record<string, any>): Promise<void> {
    const actors = await this.resolveActors(node, inst, operator, vars)
    if (!actors.length) return
    const performType = parseInt(String(node.properties?.performType ?? '0'))
    const ct = node.properties?.countersignType as string | undefined
    const now = new Date()
    const form = node.properties?.form ?? ''

    if (performType === 1 && ct) {
      switch (ct) {
        case 'PARALLEL':
          for (const actor of actors) await this.repo.saveTask(inst.createTask(this.nextId(), node.id, node.text.value, actor, operator, form, now))
          return
        case 'SEQUENTIAL': {
          const nt = inst.createTask(this.nextId(), node.id, node.text.value, actors[0], operator, form, now)
          nt.variables = {
            [`nrOfInstances_${node.id}`]: actors.length,
            [`loopCounter_${node.id}`]: 0,
            [`operatorList_${node.id}`]: actors,
          }
          await this.repo.saveTask(nt)
          return
        }
        default:
          for (const actor of actors) await this.repo.saveTask(inst.createTask(this.nextId(), node.id, node.text.value, actor, operator, form, now))
          return
      }
    }
    // 普通任务：一个任务承载全部参与者（对齐 boot3 createTask + addTaskActor，多参与者任一可办）
    const nt = inst.createTask(this.nextId(), node.id, node.text.value, actors[0], operator, form, now)
    if (actors.length > 1) nt.actorIds = actors
    await this.repo.saveTask(nt)
  }

  private async resolveActors(node: FlowNode, inst: ProcessInstance, operator: string, vars: Record<string, any>): Promise<string[]> {
    // 1a. Registry 按名称解析（推荐）
    if (this.registry) {
      const handlerName = (node.properties?.assignmentHandler as string) ?? ''
      if (handlerName) {
        const h = this.registry.resolveAssignment(handlerName)
        if (h) return await h.assign(node, inst, operator)
      }
    }
    // 1b. Extensions 兼容
    if (this.ext?.assignmentHandler) {
      const handlerName = (node.properties?.assignmentHandler as string) ?? ''
      const result = await this.ext.assignmentHandler(handlerName, node, inst)
      if (Array.isArray(result) && result.length > 0) return result
    }
    // 2. 动态指定下一节点处理人优先（v1.0.1：对齐 boot3 tf_nextNodeOperator）
    const nextOp = vars[KeyNextNodeOperator]
    if (nextOp != null) {
      if (typeof nextOp === 'string') return nextOp.split(',').map(s => s.trim()).filter(Boolean)
      if (Array.isArray(nextOp)) return nextOp.map(String)
      return [String(nextOp)]
    }
    // 3. 固定指派 assignee——token 即变量 key，能替换就换，换不了就是字面量（v1.0.1 对齐 boot3 args.get(token, token)）
    const assignee = node.properties?.assignee as string | undefined
    if (assignee) {
      const actors: string[] = []
      for (const raw of assignee.split(',')) {
        let token = raw.trim()
        if (!token) continue
        // mldong 契约特殊值：applicant → 流程发起人
        if (token.includes('applicant')) token = token.replace('applicant', inst.operator)
        if (token in vars) {
          const val = vars[token]
          if (Array.isArray(val)) actors.push(...val.map(String))
          else actors.push(String(val))
        } else {
          actors.push(token)
        }
      }
      return actors
    }
    return []
  }

  private isAllowed(task: ProcessTask, operator: string): boolean {
    // v1.0.1：系统代执行（flow.auto）/超级管理员（flow.admin）放行（对齐 boot3 isAllowed）
    if (operator && (operator.toLowerCase() === KeyAutoExecute || operator.toLowerCase() === KeyAdminID)) {
      return true
    }
    // 子实体：actorIds 权限判断
    return task.isAllowed(operator)
  }

  private async addUserInfo(operator: string, vars: Record<string, any>) {
    if (!this.userProv) return
    // v1.0.1：系统代执行（flow.auto）/超级管理员（flow.admin）非真实用户，跳过注入（对齐 boot3）
    if (operator && (operator.toLowerCase() === KeyAutoExecute || operator.toLowerCase() === KeyAdminID)) {
      return
    }
    const u = await this.userProv.getUser(operator)
    if (!u) return
    vars[KeyUserID] = u.userId
    if (u.realName) vars[KeyRealName] = u.realName
    if (u.deptId) vars[KeyDeptID] = u.deptId
    if (u.deptName) vars[KeyDeptName] = u.deptName
    if (u.postId) vars[KeyPostID] = u.postId
    if (u.postName) vars[KeyPostName] = u.postName
  }

  private nextId(): string {
    if (this.idGen) return this.idGen.nextId()
    return String(Date.now() * 1000 + Math.floor(Math.random() * 1000))
  }
}

// ─── Pure Functions ──────────────────────────────────────────────────────────

function findNode(flow: FlowModel, id: string): FlowNode | undefined {
  return flow.nodes.find(n => n.id === id)
}

function findNodeByType(flow: FlowModel, type: string): FlowNode | undefined {
  return flow.nodes.find(n => n.type === type)
}

function followEdges(flow: FlowModel, sourceId: string): FlowNode[] {
  return flow.edges
    .filter(e => e.sourceNodeId === sourceId)
    .map(e => findNode(flow, e.targetNodeId))
    .filter(Boolean) as FlowNode[]
}

function getCsState(vars: Record<string, any>, nodeId: string): [string[] | null, number] {
  const actors = vars[`operatorList_${nodeId}`] as string[] | undefined ?? null
  const lc = parseInt(String(vars[`loopCounter_${nodeId}`] ?? '0'))
  return [actors, lc]
}

// syncTaskToAggregate 把外部任务对象的最新状态同步回聚合根任务副本
// （v1.0.1：updateInstance 级联持久化依赖聚合内任务副本为最新状态）
function syncTaskToAggregate(inst: ProcessInstance, task: ProcessTask): void {
  for (let i = 0; i < inst.tasks.length; i++) {
    if (inst.tasks[i].id === task.id) {
      inst.tasks[i] = task
      return
    }
  }
}

function isTruthy(v: any): boolean {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') return v !== '' && v !== 'false'
  if (typeof v === 'number') return v !== 0
  return v != null
}


/** 办理提交的 f_ 字段按任务节点 field 权限过滤（issues/26）——
 *  任务节点 properties.field 声明 PERMISSION_f_{全名}（前端约定，优先）或
 *  PERMISSION_{去前缀名}（兼容）的字段，值非 EDIT(2)（只读 1/隐藏 3 等）→ 剔除不入变量。
 *  键格式双兼容（issues/25），与 persist 拦截器 isEditable 同契约。 */
function filterFieldByPerm(args: Record<string, any>, node: FlowNode | undefined): Record<string, any> {
  if (Object.keys(args).length === 0 || !node || (node.type !== TypeTask && node.type !== TypeCustom)) return args
  const field = node.properties?.field
  if (!field || typeof field !== 'object' || Object.keys(field as object).length === 0) return args
  const fieldPerm = field as Record<string, unknown>
  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(args)) {
    if (k.startsWith('f_') && k.length > 2) {
      const name = k.slice(2)
      let perm = fieldPerm[`PERMISSION_f_${name}`]
      if (perm == null) perm = fieldPerm[`PERMISSION_${name}`]
      if (perm != null && Number(perm) !== 2) continue // 只读/隐藏：剔除（不入变量）
    }
    out[k] = v
  }
  return out
}
