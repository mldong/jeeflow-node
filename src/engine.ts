import {
  type FlowModel, type FlowNode,
  TypeStart, TypeEnd, TypeTask, TypeDecision, TypeFork, TypeJoin, TypeCustom,
  ProcessInstance, type ProcessTask, type ProcessDefine,
  InstanceState, TaskState,
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

export interface Engine {
  startProcessInstanceById(defineId: number, operator: string, args?: Record<string, any>): Promise<ProcessInstance>
  executeProcessTask(taskId: number, operator: string, args?: Record<string, any>): Promise<ProcessInstance>
  executeAndJumpToEnd(taskId: number, operator: string, args?: Record<string, any>): Promise<ProcessInstance>
  executeAndJumpTask(taskId: number, operator: string, args: Record<string, any>, targetTaskName?: string): Promise<ProcessInstance>
  executeAndJumpToFirstTaskNode(taskId: number, operator: string, args?: Record<string, any>): Promise<ProcessInstance>
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

  setExtensions(ext: EngineExtensions) { this.ext = ext }
  setRegistry(reg: HandlerRegistry) { this.registry = reg }

  private async firePre(node: FlowNode, inst: ProcessInstance): Promise<boolean> {
    if (!this.ext?.interceptors) return true
    for (const ic of this.ext.interceptors.sort((a, b) => a.order - b.order))
      if (!(await ic.preHandle(node, inst))) return false
    return true
  }
  private async firePost(node: FlowNode, inst: ProcessInstance) {
    if (!this.ext?.interceptors) return
    for (const ic of this.ext.interceptors) await ic.postHandle(node, inst)
  }
  private async fireEvent(evt: ProcessEvent) {
    if (!this.ext?.listeners) return
    for (const l of this.ext.listeners) await l(evt)
  }

  // ─── Start ─────────────────────────────────────────────────────────────────

  async startProcessInstanceById(defineId: number, operator: string, args: Record<string, any> = {}): Promise<ProcessInstance> {
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

  async executeProcessTask(taskId: number, operator: string, args: Record<string, any> = {}): Promise<ProcessInstance> {
    const { task, inst } = await this.loadAndCheck(taskId, operator)
    const vars = { ...inst.variables, ...task.variables, ...args }
    await this.addUserInfo(operator, vars)

    const now = new Date()
    // 聚合根：完成任务（子实体状态转换 + 实例变量合并）
    inst.completeTask(task, operator, vars, now)
    await this.repo.updateTask(task)
    await this.fireEvent({ type: EventType.TaskComplete, instanceId: inst.id, taskId: task.id, nodeId: task.taskName, operator })

    const def = await this.repo.findDefineById(inst.defineId)
    const flow: FlowModel = JSON.parse(typeof def!.content === 'string' ? def!.content : new TextDecoder().decode(def!.content as Uint8Array))
    inst.variables = vars
    await this.repo.updateInstance(inst)

    const curNode = findNode(flow, task.taskName)
    if (curNode) {
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
        if (node.type === TypeEnd) {
          // 聚合根：流程完成
          inst.finish(new Date())
          inst.variables = vars
          await this.repo.updateInstance(inst)
          await this.fireEvent({ type: EventType.ProcessFinish, instanceId: inst.id, operator })
        } else {
          await this.executeNode(flow, inst, node, operator, vars)
        }
      }
    }
    return (await this.repo.findInstanceById(inst.id))!
  }

  // ─── Reject ────────────────────────────────────────────────────────────────

  async executeAndJumpToEnd(taskId: number, operator: string, args: Record<string, any> = {}): Promise<ProcessInstance> {
    const { task, inst } = await this.loadAndCheck(taskId, operator)
    const now = new Date()
    // 聚合根：废弃所有进行中任务
    for (const t of inst.abandonAllDoing(now)) await this.repo.updateTask(t)
    // 子实体：完成任务
    task.finish(operator, task.variables, now)
    await this.repo.updateTask(task)
    // 聚合根：驳回
    inst.reject(now)
    await this.repo.updateInstance(inst)
    await this.fireEvent({ type: EventType.ProcessReject, instanceId: inst.id, taskId, operator })
    return inst
  }

  // ─── Jump ──────────────────────────────────────────────────────────────────

  async executeAndJumpTask(taskId: number, operator: string, args: Record<string, any> = {}, targetTaskName?: string): Promise<ProcessInstance> {
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

  async executeAndJumpToFirstTaskNode(taskId: number, operator: string, args: Record<string, any> = {}): Promise<ProcessInstance> {
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

  private async loadAndCheck(taskId: number, operator: string) {
    const task = await this.repo.findTaskById(taskId)
    if (!task) throw new Error(`task not found: ${taskId}`)
    if (task.taskState !== TaskState.Doing) throw new Error(`task not doing`)
    if (!this.isAllowed(task, operator)) throw new Error(`operator ${operator} not allowed`)
    const inst = await this.repo.findInstanceById(task.processInstanceId)
    if (!inst) throw new Error(`instance not found`)
    return { task, inst }
  }

  private async executeNode(flow: FlowModel, inst: ProcessInstance, node: FlowNode, operator: string, vars: Record<string, any>): Promise<void> {
    if (!(await this.firePre(node, inst))) return
    try {
    switch (node.type) {
      case TypeTask: case TypeCustom:
        return this.createTask(node, inst, operator, vars)
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
      case TypeEnd:
        inst.finish(new Date())
        inst.variables = vars
        await this.repo.updateInstance(inst)
        await this.fireEvent({ type: EventType.ProcessFinish, instanceId: inst.id, operator })
        return
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

  private async createTask(node: FlowNode, inst: ProcessInstance, operator: string, _vars: Record<string, any>): Promise<void> {
    const actors = await this.resolveActors(node, inst)
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
    await this.repo.saveTask(inst.createTask(this.nextId(), node.id, node.text.value, actors[0], operator, form, now))
  }

  private async resolveActors(node: FlowNode, inst: ProcessInstance): Promise<string[]> {
    // 1a. Registry 按名称解析（推荐）
    if (this.registry) {
      const handlerName = (node.properties?.assignmentHandler as string) ?? ''
      if (handlerName) {
        const h = this.registry.resolveAssignment(handlerName)
        if (h) return await h.assign(node, inst)
      }
    }
    // 1b. Extensions 兼容
    if (this.ext?.assignmentHandler) {
      const handlerName = (node.properties?.assignmentHandler as string) ?? ''
      const result = await this.ext.assignmentHandler(handlerName, node, inst)
      if (Array.isArray(result) && result.length > 0) return result
    }
    // 2. 固定指派 assignee（boot2 约定："applicant" → 解析为流程发起人）
    const assignee = node.properties?.assignee as string | undefined
    if (assignee) {
      const actors = assignee.split(',').map(s => s.trim()).filter(Boolean)
      return actors.map(a => (a === 'applicant' ? inst.operator : a))
    }
    return []
  }

  private isAllowed(task: ProcessTask, operator: string): boolean {
    // 子实体：actorIds 权限判断
    return task.isAllowed(operator)
  }

  private async addUserInfo(operator: string, vars: Record<string, any>) {
    if (!this.userProv) return
    const u = await this.userProv.getUser(operator)
    if (!u) return
    vars[KeyUserID] = u.userId
    if (u.realName) vars[KeyRealName] = u.realName
    if (u.deptId) vars[KeyDeptID] = u.deptId
    if (u.deptName) vars[KeyDeptName] = u.deptName
    if (u.postId) vars[KeyPostID] = u.postId
    if (u.postName) vars[KeyPostName] = u.postName
  }

  private nextId(): number {
    if (this.idGen) return this.idGen.nextId()
    return Date.now() * 1000 + Math.floor(Math.random() * 1000)
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

function isTruthy(v: any): boolean {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') return v !== '' && v !== 'false'
  if (typeof v === 'number') return v !== 0
  return v != null
}
