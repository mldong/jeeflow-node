import {
  type FlowModel, type FlowNode,
  TypeStart, TypeEnd, TypeTask, TypeDecision, TypeFork, TypeJoin, TypeCustom,
  ProcessInstance, type ProcessTask, type ProcessDefine,
  InstanceState, TaskState, SubmitType,
} from './model.js'
import type { ProcessRepository, ProcessExtRepository, UserProvider, IDGenerator, ExpressionEvaluator } from './spi.js'
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
// issue 29：自动生成标题（对齐 boot3 FlowConst.AUTO_GEN_TITLE）
export const KeyAutoGenTitle = 'autoGenTitle'

export interface Engine {
  startProcessInstanceById(defineId: string, operator: string, args?: Record<string, any>): Promise<ProcessInstance>
  executeProcessTask(taskId: string, operator: string, args?: Record<string, any>): Promise<ProcessInstance>
  executeAndJumpToEnd(taskId: string, operator: string, args?: Record<string, any>): Promise<ProcessInstance>
  executeAndJumpTask(taskId: string, operator: string, args: Record<string, any>, targetTaskName?: string): Promise<ProcessInstance>
  executeAndJumpToFirstTaskNode(taskId: string, operator: string, args?: Record<string, any>): Promise<ProcessInstance>
}

/**
 * 委托代理自动生效的注入面（issues/116）——只需要 getSurrogate 一侧能力，
 * 完整 ProcessExtRepository 天然满足；传 `{ getSurrogate: async () => null }`
 * 即为"注册空实现"关闭形态。
 */
export type SurrogateLookup = Pick<ProcessExtRepository, 'getSurrogate'>

/** 引擎委托配置（构造参数与 setSurrogateOptions 共用同一形状） */
export interface EngineOptions {
  /** 委托查询源；不传 = 未配置扩展仓储 → 引擎静默跳过委托（不打断建单） */
  surrogateRepository?: SurrogateLookup | null
  /** 委托自动生效开关，**默认 true（引擎内置开启）**；显式传 false → 回到"仅台账"行为 */
  surrogateEnabled?: boolean
}

/**
 * 照 mldong-boot2 NodeModel.canRejected：自 current 的入边回溯，命中 parent 放行；
 * 入边来源是 fork/join/start 时**跳过该条入边、不再深入**（boot2 是 continue，不是穿越），
 * 其余来源递归。subprocess 在 boot2 里被注释掉，等同普通节点。
 */
function canRejected(flow: FlowModel, currentId: string, parentId: string): boolean {
  for (const edge of flow.edges) {
    if (edge.targetNodeId !== currentId) continue
    if (edge.sourceNodeId === parentId) return true
    const src = findNode(flow, edge.sourceNodeId)
    if (!src) continue
    if (src.type === TypeFork || src.type === TypeJoin || src.type === TypeStart) continue
    if (canRejected(flow, src.id, parentId)) return true
  }
  return false
}

// 复活行的变量净化：剔控制类残留（submitType / taskName / tf_ 前缀 / csv_ 前缀 / 会签簿记），
// 保留 f_ 表单字段、u_ 用户快照、autoGenTitle、isFirstTaskNode。
function lineageVars(src: Record<string, any> | undefined): Record<string, any> {
  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(src ?? {})) {
    if (k === 'submitType' || k === 'taskName'
        || k.startsWith('tf_') || k.startsWith('csv_')
        || k.startsWith('loopCounter') || k.startsWith('nrOfInstances')
        || k.startsWith('operatorList')) continue
    out[k] = v
  }
  return out
}

export class EngineImpl implements Engine {
  private ext?: EngineExtensions
  private registry?: HandlerRegistry
  // issues/116：委托代理自动生效——内置能力，注入查询源后默认开启
  private surrogateRepo?: SurrogateLookup | null
  private surrogateOn = true

  constructor(
    private repo: ProcessRepository,
    private userProv?: UserProvider,
    private idGen?: IDGenerator,
    private exprEval?: ExpressionEvaluator,
    opts?: EngineOptions,
  ) {
    if (opts?.surrogateRepository !== undefined) this.surrogateRepo = opts.surrogateRepository
    if (opts?.surrogateEnabled !== undefined) this.surrogateOn = opts.surrogateEnabled
  }

  /**
   * issues/116：注入/摘除委托查询源（ProcessExtRepository 或任何实现 getSurrogate 的对象）。
   * 传 null 摘除 = 关闭委托自动生效（回到"仅台账"）。不影响已设置的开关。
   */
  setSurrogateRepository(repo: SurrogateLookup | null): this {
    this.surrogateRepo = repo
    return this
  }

  /**
   * issues/116：委托自动生效开关（**默认开启**）。传 false 显式关闭 → 建单不再并入代理人。
   */
  setSurrogateEnabled(enabled: boolean): this {
    this.surrogateOn = enabled
    return this
  }

  /** issues/116：组合设置（与构造参数同形状），未给的字段保持现状 */
  setSurrogateOptions(opts: EngineOptions): this {
    if (opts.surrogateRepository !== undefined) this.surrogateRepo = opts.surrogateRepository
    if (opts.surrogateEnabled !== undefined) this.surrogateOn = opts.surrogateEnabled
    return this
  }

  /** 委托自动生效当前是否启用（只读，供集成层自检/测试用） */
  isSurrogateEnabled(): boolean {
    return this.surrogateOn && this.surrogateRepo != null
  }

  /** defineId → wf_process_define.name 缓存（仅"模型未带 name"的回落路径用得到） */
  private defineNameCache = new Map<string, string>()

  /**
   * issues/116 契约 1.1：委托查询的 processName **以流程模型 name 为准**
   * （迁移基线 = 内置版 SurrogateInterceptor 取的 `execution.getProcessModel().getName()`），
   * 模型未带 name（缺失/空串/纯空白）时才回落 `wf_process_define.name`。
   * 正常 deploy 两者恒等（saveDeployedDefine 执行 `def.name = flow.name`），但直接落库的
   * 定义（测试 loadFlow、集成方自带导入链路）会不一致——取错那一头，用户在内置版配的
   * 委托迁到 jeeflow 后就不再命中。对齐 Go `EngineImpl.surrogateProcessName` 同判据同姿势。
   */
  private async surrogateProcessName(flow: FlowModel, inst: ProcessInstance): Promise<string> {
    const fromModel = typeof flow?.name === 'string' ? flow.name.trim() : ''
    if (fromModel) return fromModel
    if (inst?.defineId == null) return ''
    const key = String(inst.defineId)
    const cached = this.defineNameCache.get(key)
    if (cached !== undefined) return cached
    let name = ''
    try {
      const def = await this.repo.findDefineById(inst.defineId)
      name = typeof def?.name === 'string' ? def.name.trim() : ''
    } catch {
      /* 定义读取失败按"拿不到流程名"处理：只命中全流程兜底委托，绝不打断建单（判据 4） */
    }
    this.defineNameCache.set(key, name)
    return name
  }

  setExtensions(ext: EngineExtensions) {
    this.ext = ext
    this.interceptorCache = new Map()
  }
  setRegistry(reg: HandlerRegistry) { this.registry = reg }

  private interceptorCache = new Map<string, FlowInterceptor[]>()

  /** 定义级拦截器解析（issue 34，对齐 Java 模型级 postInterceptors）：
   *  流程定义顶层 postInterceptors 声明 → 按名从 interceptorRegistry 取（未声明该流程不触发）；
   *  未声明 → 回落引擎级列表（向后兼容）。结果按 defineId 缓存。
   *  issues/60：解析与校验分离——定义读取/JSON 解析失败回落引擎级（现状语义），
   *  声明中存在未注册名时抛错（不静默跳过），且错误不写缓存保证持续报错。 */
  private async resolveInterceptors(inst: ProcessInstance): Promise<FlowInterceptor[]> {
    if (!this.ext) return []
    const defineId = inst.defineId
    if (defineId == null) return this.ext.interceptors ?? []
    const cached = this.interceptorCache.get(defineId)
    if (cached) return cached
    let list = this.ext.interceptors ?? []
    let declared = ''
    try {
      const def = await this.repo.findDefineById(defineId)
      if (def) {
        const content = typeof def.content === 'string' ? def.content : new TextDecoder().decode(def.content as Uint8Array)
        const meta = JSON.parse(content)
        declared = String(meta.postInterceptors ?? '').trim()
      }
    } catch { /* 定义读取/JSON 解析失败回落引擎级 */ }
    if (declared) {
      list = []
      for (const name of declared.split(',').map(n => n.trim())) {
        if (!name) continue
        const ic = this.ext.interceptorRegistry?.[name]
        if (!ic) throw new Error(`postInterceptors 声明的拦截器未注册: ${name}`)
        list.push(ic)
      }
    }
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
  async fireEvent(evt: ProcessEvent) {
    // 公开事件发布入口（issues/102 CC_CREATE）：facade 层 CC 实例创建后逐抄送人 fire；
    // 无监听器（ext/listeners 为空）时零副作用，与上一版逐字节一致
    await this.#fireEvent(evt)
  }
  async #fireEvent(evt: ProcessEvent) {
    if (!this.ext?.listeners) return
    // 兜底语义（issues/104 P2 统一口径）：单监听器异常只记录不传播——
    // 不得影响引擎主流程，也不得中断后续监听器（对齐 PHP per-listener catch）
    for (const l of this.ext.listeners) {
      try {
        await l(evt)
      } catch (e) {
        console.error(`[jeeflow] process event listener error: type=${evt.type} instanceId=${evt.instanceId}`, e)
      }
    }
  }

  // ─── Start ─────────────────────────────────────────────────────────────────

  async startProcessInstanceById(defineId: string, operator: string, args: Record<string, any> = {}): Promise<ProcessInstance> {
    const def = await this.repo.findDefineById(defineId)
    if (!def) throw new Error(`define not found: ${defineId}`)
    const content = typeof def.content === 'string' ? def.content : new TextDecoder().decode(def.content as Uint8Array)
    const flow: FlowModel = JSON.parse(content)

    const vars = { ...args }
    await this.addUserInfo(operator, vars)
    this.addAutoGenTitle(def.displayName, vars)

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
    const { task, inst, flow, vars } = await this.prepareExecuteTask(taskId, operator, args)
    const now = new Date()
    const curNode = findNode(flow, task.taskName)
    if (curNode) {
      // 1.8.0：任务完成节点自身的后置拦截器（SYNC 同步演进——任务节点推进更新状态/字段）。
      // createTask 不再触发（引擎语义修正），此处为完成任务节点的唯一触发点
      await this.firePost(curNode, inst)
      const ct = curNode.properties?.countersignType as string | undefined
      const csCond = String(curNode.properties?.countersignCompletionCondition ?? '').trim()
      // issues/91：会签一票否决仅当节点配置 ONE_VOTE_VETO（忽略大小写）时生效，
      // submitType=20 才跳过会签"未完成即停留"门控提前流转；否则为软拒绝——
      // 否决者任务正常完成、countersignDisagreeFlag=1 已记录为变量（供下游参考），
      // 流程不阻断（对齐 mldong 内置引擎 / Java CountersignHandler）
      const csVeto = !!ct && csCond.toUpperCase() === 'ONE_VOTE_VETO' &&
        Number(vars[KeySubmitType]) === Number(SubmitType.CountersignDisagree)
      if (ct === 'SEQUENTIAL' && !csVeto) {
        const doing = await this.repo.findDoingTasks(inst.id)
        if (doing.length === 0) {
          const [actors, lc] = getCsState(vars, curNode.id)
          if (actors && lc + 1 < actors.length) {
            // 聚合根：创建串行会签下一步任务
            const nt = inst.createTask(this.nextId(), curNode.id, curNode.text.value, actors[lc + 1], operator, curNode.properties?.form ?? '', now,
              task.id, this.isFirstTaskNode(flow, curNode), 1)
            nt.variables = { isFirstTaskNode: nt.variables.isFirstTaskNode,
              [`nrOfInstances_${curNode.id}`]: actors.length,
              [`loopCounter_${curNode.id}`]: lc + 1,
              [`operatorList_${curNode.id}`]: actors,
            }
            // issues/116：串行会签推进出的新任务同样并入该成员生效中的代理人
            const pn = await this.surrogateProcessName(flow, inst)
            const eff = mergeAgents([actors[lc + 1]], await this.surrogateAgents([actors[lc + 1]], pn))
            if (eff.length > 1) nt.actorIds = eff
            await this.repo.saveTask(nt)
            // TASK_CREATE：顺序会签推进新任务落库后 fire（对齐 Java CreateTaskHandler / Rust）
            await this.fireEvent({ type: EventType.TaskCreate, instanceId: inst.id, taskId: nt.id, nodeId: curNode.id, operator })
            return (await this.repo.findInstanceById(inst.id))!
          }
        } else {
          return (await this.repo.findInstanceById(inst.id))!
        }
      }
      if ((ct === 'PARALLEL' || ct?.startsWith('RATIO')) && !csVeto) {
        const doing = await this.repo.findDoingTasks(inst.id)
        if (doing.length > 0) return (await this.repo.findInstanceById(inst.id))!
      }
      // issues/91：会签节点 merged 后（ONE_VOTE_VETO 否决 / 全部完成任一路径），
      // 废弃该节点剩余 DOING 任务（对齐内置引擎 abandonProcessTask）：
      // SEQUENTIAL 逐人创建天然 no-op；PARALLEL 全员预创建，否决时废弃其余成员
      // （刚完成者已 Done 不会误伤）。逐条持久化并回写聚合副本（E25：防 updateInstance 级联回写旧状态）
      if (ct) {
        const remaining = await this.repo.findDoingTasks(inst.id, [curNode.id])
        for (const t of remaining) {
          t.abandon(now)
          await this.repo.updateTask(t)
          syncTaskToAggregate(inst, t)
        }
      }
      for (const node of followEdges(flow, curNode.id)) {
        // 统一走 executeNode：结束节点也经节点执行链（拦截器/事件完整触发），
        // executeNode 内部 TypeEnd 分支完成聚合根 finish + 事件发布
        await this.executeNode(flow, inst, node, operator, vars, task.id)
      }
    }
    return (await this.repo.findInstanceById(inst.id))!
  }

  // ─── Reject ────────────────────────────────────────────────────────────────

  async executeAndJumpToEnd(taskId: string, operator: string, args: Record<string, any> = {}): Promise<ProcessInstance> {
    const { inst } = await this.prepareExecuteTask(taskId, operator, args)
    // 门面 submitType=2 REJECT 唯一入口（对齐 Java executeAndJumpToEnd 语义）
    inst.reject(new Date())
    await this.repo.updateInstance(inst)
    await this.fireEvent({ type: EventType.ProcessReject, instanceId: inst.id, taskId, operator })
    return (await this.repo.findInstanceById(inst.id))!
  }

  // ─── Jump（ROLLBACK 空 target / JUMP 命名 target，boot2 executeAndJumpTask）────

  async executeAndJumpTask(taskId: string, operator: string, args: Record<string, any> = {}, targetTaskName?: string): Promise<ProcessInstance> {
    const { task, inst, flow, vars } = await this.prepareExecuteTask(taskId, operator, args)
    if (!targetTaskName) {
      // issues/121 P2：ROLLBACK 走血缘版——复活 task.parentTaskId 指的那条历史行，
      // 参与者＝该行办结人（首任务节点行取该行 u_userId）。无血缘/守卫不过显式报错，
      // 不再像拓扑版那样"什么都不做、实例保持 DOING 却零待办"。
      await this.rollbackToParent(flow, inst, task, operator)
    } else {
      // issues/79：对齐 Java——目标节点不存在显式报错（前端 JUMP 无效 taskName 不再静默空操作）
      const target = findNode(flow, targetTaskName)
      if (!target) throw new Error(`根据节点名称[${targetTaskName}]无法找到节点模型`)
      // 对齐 Java isFirstTaskName：跳首任务节点（start 直接后继）assignee 强制为发起人
      if (target.type === TypeTask && this.isFirstTaskNode(flow, target)) {
        target.properties = target.properties ?? {}
        target.properties.assignee = inst.operator
      }
      await this.executeNode(flow, inst, target, operator, vars, task.id)
    }
    return (await this.repo.findInstanceById(inst.id))!
  }

  // ─── Jump To First Task（退回发起人，boot2 ROLLBACK_TO_OPERATOR=6）────────────

  async executeAndJumpToFirstTaskNode(taskId: string, operator: string, args: Record<string, any> = {}): Promise<ProcessInstance> {
    const { inst, flow, vars } = await this.prepareExecuteTask(taskId, operator, args)
    // 找到第一个任务节点，强制参与者为发起人，重新执行
    const startNode = findNodeByType(flow, TypeStart)
    if (startNode) {
      for (const node of followEdges(flow, startNode.id)) {
        if (node.type === TypeTask || node.type === TypeCustom) {
          node.properties = node.properties ?? {}
          node.properties.assignee = inst.operator
          await this.executeNode(flow, inst, node, operator, vars, taskId)
          break
        }
      }
    }
    return (await this.repo.findInstanceById(inst.id))!
  }

  // ─── Execute 公共序言（对齐 Java prepareExecution）──────────────────────────

  // 执行公共序言（对齐 Java prepareExecution）：权限校验 → f_ 字段权限过滤 →
  // 完成任务（子实体状态转换 + 实例变量合并，经 updateInstance 级联落库）→
  // 返回流程模型 + 合并后执行变量。Java jump 路径不废弃其余 DOING 任务
  // （会签兄弟任务不受影响），此处保持一致。
  private async prepareExecuteTask(taskId: string, operator: string, args: Record<string, any>) {
    const { task, inst } = await this.loadAndCheck(taskId, operator)
    // issues/26：办理提交的 f_ 字段按任务节点字段权限过滤（只读/隐藏不入变量）
    const def = await this.repo.findDefineById(inst.defineId)
    const flow: FlowModel = JSON.parse(typeof def!.content === 'string' ? def!.content : new TextDecoder().decode(def!.content as Uint8Array))
    args = filterFieldByPerm(args, findNode(flow, task.taskName))
    // issues/97：捕获原始实例变量（start 注入的发起人 u_*）——操作人 u_* 只进执行上下文
    // 与任务行，不得整体写回实例（对齐 Java completeTask=putAll(args)，args 不含 u_*）。
    const baseVars = inst.variables
    const vars = { ...baseVars, ...task.variables, ...args }
    await this.addUserInfo(operator, vars)

    const now = new Date()
    // 聚合根：完成任务（子实体状态转换 + 实例变量合并）
    inst.completeTask(task, operator, vars, now)
    await this.repo.updateTask(task)
    // v1.0.1：updateInstance 级联持久化依赖聚合内任务副本为最新状态，
    // completeTask 改的是外部任务对象，需同步回聚合根
    syncTaskToAggregate(inst, task)
    await this.fireEvent({ type: EventType.TaskComplete, instanceId: inst.id, taskId: task.id, nodeId: task.taskName, operator })

    // issues/97：实例变量写回排除操作人 u_*，保留 start 注入的发起人 u_*（u_realName 恒为发起人）
    inst.variables = mergeExecIntoInstance(baseVars, vars)
    await this.repo.updateInstance(inst)
    return { task, inst, flow, vars }
  }

  // 是否 start 直接后继任务节点（issues/79 对齐 Java FlowUtil.isFirstTaskName）
  private isFirstTaskNode(flow: FlowModel, node: FlowNode): boolean {
    const start = findNodeByType(flow, TypeStart)
    if (!start) return false
    return flow.edges.some(e => e.sourceNodeId === start.id && e.targetNodeId === node.id)
  }

  /**
   * 退回上一步（血缘版，规范 04 · 退回上一步）：上一步来源＝当前行的 parentTaskId，
   * 复活那条历史行；不按模型入边拓扑推（拓扑版在分支/回环流会回到本实例没走过的节点，
   * 还会静默留下"实例 DOING 却零待办"）。错码写在 msg 前缀（出口统一 99999999）。
   */
  private async rollbackToParent(flow: FlowModel, inst: ProcessInstance,
                                  task: ProcessTask, operator: string): Promise<void> {
    const NO_LINEAGE = '20010007: 上一步任务ID为空，无法驳回至上一步处理'
    const GUARD = '20010008: 无法驳回至上一步处理，请确认上一步骤并非fork、join、suprocess以及会签任务'
    const parentId = task.parentTaskId
    if (!parentId || parentId === '0') throw new Error(NO_LINEAGE)
    const his = await this.repo.findTaskById(parentId)
    if (!his) throw new Error(NO_LINEAGE)
    const prev = findNode(flow, his.taskName)
    if (!prev || !canRejected(flow, task.taskName, prev.id)) throw new Error(GUARD)
    // 首任务节点那条由发起人提交 ⇒ 参与者取该行 u_userId；其余取该行办结人。
    // 老行没这个键 ⇒ 按 false 处理（宁可派给该行 actorId，也不用带"仅进行中"判定的现算值）。
    const isFirst = his.variables?.isFirstTaskNode === true
    let actor = isFirst ? String(his.variables?.u_userId ?? '') || inst.operator : his.actorId
    if (!actor) throw new Error(NO_LINEAGE)
    const nt = inst.createTask(this.nextId(), prev.id, prev.text.value, actor,
      his.createUser ?? '', prev.properties?.form ?? '', new Date(),
      his.parentTaskId ?? '0', isFirst, his.performType)
    // 复活行只带数据类键：tf_*（上次表单提交）与 csv_*/会签簿记都是"上次提交"的残留
    nt.variables = { ...lineageVars(his.variables), isFirstTaskNode: isFirst }
    const agents = await this.surrogateAgents([actor], await this.surrogateProcessName(flow, inst))
    const eff = mergeAgents([actor], agents)
    if (eff.length > 1) nt.actorIds = eff
    await this.repo.saveTask(nt)
    await this.fireEvent({ type: EventType.TaskCreate, instanceId: inst.id,
      taskId: nt.id, nodeId: prev.id, operator })
  }

  /**
   * issues/116：对每个参与人查一次生效委托（判据在仓储侧：空 processName 全流程兜底 /
   * 时间窗 / 自委托过滤 / enabled 只认 1）。返回 actor → 代理人 映射。
   * 未配置查询源、显式关闭、无参与人 → 空映射（= 原样参与者，不打断建单）；
   * 单条查询异常只记录不传播（委托是增强能力，建单主流程不得被拖崩）。
   */
  private async surrogateAgents(actors: string[], processName: string): Promise<Map<string, string>> {
    const map = new Map<string, string>()
    const ext = this.surrogateRepo
    if (!ext || !this.surrogateOn || actors.length === 0) return map
    const now = new Date()
    for (const actor of actors) {
      try {
        const hit = await ext.getSurrogate(actor, processName ?? '', now)
        const agent = typeof hit?.surrogate === 'string' ? hit.surrogate.trim() : ''
        if (agent && agent !== actor) map.set(actor, agent)
      } catch (e: any) {
        console.error(`[jeeflow] 委托查询失败（跳过该参与人）actor=${actor}:`, e?.message ?? e)
      }
    }
    return map
  }

  // 以显式参与者建任务（会签节点拆分为逐人任务，对齐 Java 会签创建语义）
  private async createTaskWithActors(node: FlowNode, inst: ProcessInstance, operator: string, vars: Record<string, any>, actors: string[], processName = '',
                                          parentId: string = '0', isFirst: boolean = false): Promise<void> {
    if (!actors.length) return
    // issues/116：与 createTask 同口径——代理人并入参与者集合后随任务落库
    const agents = await this.surrogateAgents(actors, processName)
    const ct = node.properties?.countersignType as string | undefined
    const now = new Date()
    const form = node.properties?.form ?? ''
    if (isCountersign(node.properties?.performType) && ct) {
      switch (ct) {
        case 'PARALLEL':
        case '':
          for (const actor of actors) {
            const nt = inst.createTask(this.nextId(), node.id, node.text.value, actor, operator, form, now, parentId, isFirst, 1)
            const eff = mergeAgents([actor], agents)
            if (eff.length > 1) nt.actorIds = eff
            await this.repo.saveTask(nt)
            await this.fireEvent({ type: EventType.TaskCreate, instanceId: inst.id, taskId: nt.id, nodeId: node.id, operator })
          }
          return
        case 'SEQUENTIAL': {
          const nt = inst.createTask(this.nextId(), node.id, node.text.value, actors[0], operator, form, now, parentId, isFirst, 1)
          nt.variables = { isFirstTaskNode: nt.variables.isFirstTaskNode,
            [`nrOfInstances_${node.id}`]: actors.length,
            [`loopCounter_${node.id}`]: 0,
            [`operatorList_${node.id}`]: actors,
          }
          const eff = mergeAgents([actors[0]], agents)
          if (eff.length > 1) nt.actorIds = eff
          await this.repo.saveTask(nt)
          await this.fireEvent({ type: EventType.TaskCreate, instanceId: inst.id, taskId: nt.id, nodeId: node.id, operator })
          return
        }
        default:
          for (const actor of actors) {
            const nt = inst.createTask(this.nextId(), node.id, node.text.value, actor, operator, form, now, parentId, isFirst, 1)
            const eff = mergeAgents([actor], agents)
            if (eff.length > 1) nt.actorIds = eff
            await this.repo.saveTask(nt)
            await this.fireEvent({ type: EventType.TaskCreate, instanceId: inst.id, taskId: nt.id, nodeId: node.id, operator })
          }
          return
      }
    }
    const effActors = mergeAgents(actors, agents)
    const nt = inst.createTask(this.nextId(), node.id, node.text.value, effActors[0], operator, form, now, parentId, isFirst)
    if (effActors.length > 1) nt.actorIds = effActors
    await this.repo.saveTask(nt)
    await this.fireEvent({ type: EventType.TaskCreate, instanceId: inst.id, taskId: nt.id, nodeId: node.id, operator })
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

  private async executeNode(flow: FlowModel, inst: ProcessInstance, node: FlowNode, operator: string, vars: Record<string, any>,
                        parentId: string = '0'): Promise<void> {
    // 任务创建（对齐 Java CreateTaskHandler：不触发节点拦截器——创建任务 ≠ 节点执行完成；
    // 任务完成的拦截器由 executeProcessTask 显式触发，1.8.0 SYNC 同步演进）
    if (node.type === TypeTask || node.type === TypeCustom) {
      await this.createTask(node, inst, operator, vars, await this.surrogateProcessName(flow, inst),
        parentId, this.isFirstTaskNode(flow, node))
      return
    }
    if (!(await this.firePre(node, inst))) return
    try {
    switch (node.type) {
      case TypeDecision:
        return this.evaluateDecision(flow, inst, node, operator, vars, parentId)
      case TypeFork:
        for (const n of followEdges(flow, node.id)) await this.executeNode(flow, inst, n, operator, vars, parentId)
        return
      case TypeJoin: {
        const doing = await this.repo.findDoingTasks(inst.id)
        if (doing.length === 0)
          for (const n of followEdges(flow, node.id)) await this.executeNode(flow, inst, n, operator, vars, parentId)
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
        // issues/97：结束节点写回同样排除操作人 u_*（保留发起人 u_*，与 prepareExecuteTask 一致）
        inst.variables = mergeExecIntoInstance(inst.variables, vars)
        await this.repo.updateInstance(inst)
        await this.fireEvent({ type: EventType.ProcessFinish, instanceId: inst.id, operator })
        return
      }
    }
    } finally { await this.firePost(node, inst) }
  }

  private async evaluateDecision(flow: FlowModel, inst: ProcessInstance, node: FlowNode, operator: string, vars: Record<string, any>, parentId: string = '0'): Promise<void> {
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
                if (target) return this.executeNode(flow, inst, target, operator, vars, parentId)
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
            if (target) return this.executeNode(flow, inst, target, operator, vars, parentId)
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
        if (target) return this.executeNode(flow, inst, target, operator, vars, parentId)
        return
      }
      if (this.exprEval) {
        const result = await this.exprEval.eval(expr, vars)
        if (isTruthy(result)) {
          const target = findNode(flow, edge.targetNodeId)
          if (target) return this.executeNode(flow, inst, target, operator, vars, parentId)
          return
        }
      }
    }
  }

  private async createTask(node: FlowNode, inst: ProcessInstance, operator: string, vars: Record<string, any>, processName = '',
                       parentId: string = '0', isFirst: boolean = false): Promise<void> {
    const actors = await this.resolveActors(node, inst, operator, vars)
    if (!actors.length) return
    // issues/116：参与者解析完成后、落库前应用生效委托——代理人并入参与者集合，
    // 随任务一起 saveTask 落 wf_process_task_actor（严禁"事后 addTaskActor 补写"）
    const agents = await this.surrogateAgents(actors, processName)
    const ct = node.properties?.countersignType as string | undefined
    const now = new Date()
    const form = node.properties?.form ?? ''

    if (isCountersign(node.properties?.performType) && ct) {
      switch (ct) {
        case 'PARALLEL':
          for (const actor of actors) {
            const nt = inst.createTask(this.nextId(), node.id, node.text.value, actor, operator, form, now, parentId, isFirst, 1)
            const eff = mergeAgents([actor], agents)
            if (eff.length > 1) nt.actorIds = eff
            await this.repo.saveTask(nt)
            // TASK_CREATE：任务落库后逐个 fire（会签多任务逐个，对齐 Java CreateTaskHandler）
            await this.fireEvent({ type: EventType.TaskCreate, instanceId: inst.id, taskId: nt.id, nodeId: node.id, operator })
          }
          return
        case 'SEQUENTIAL': {
          // 顺序会签任务也是会签任务（issues/57 E29 修正：仅普通分支默认 0）
          const nt = inst.createTask(this.nextId(), node.id, node.text.value, actors[0], operator, form, now, parentId, isFirst, 1)
          // 会签成员列表保持原 actors（委托不新增会签成员，只在该成员的任务上并入代理人）
          nt.variables = { isFirstTaskNode: nt.variables.isFirstTaskNode,
            [`nrOfInstances_${node.id}`]: actors.length,
            [`loopCounter_${node.id}`]: 0,
            [`operatorList_${node.id}`]: actors,
          }
          const eff = mergeAgents([actors[0]], agents)
          if (eff.length > 1) nt.actorIds = eff
          await this.repo.saveTask(nt)
          await this.fireEvent({ type: EventType.TaskCreate, instanceId: inst.id, taskId: nt.id, nodeId: node.id, operator })
          return
        }
        default:
          for (const actor of actors) {
            const nt = inst.createTask(this.nextId(), node.id, node.text.value, actor, operator, form, now, parentId, isFirst, 1)
            const eff = mergeAgents([actor], agents)
            if (eff.length > 1) nt.actorIds = eff
            await this.repo.saveTask(nt)
            await this.fireEvent({ type: EventType.TaskCreate, instanceId: inst.id, taskId: nt.id, nodeId: node.id, operator })
          }
          return
      }
    }
    // 普通任务：一个任务承载全部参与者（对齐 boot3 createTask + addTaskActor，多参与者任一可办）
    const effActors = mergeAgents(actors, agents)
    const nt = inst.createTask(this.nextId(), node.id, node.text.value, effActors[0], operator, form, now, parentId, isFirst)
    if (effActors.length > 1) nt.actorIds = effActors
    await this.repo.saveTask(nt)
    await this.fireEvent({ type: EventType.TaskCreate, instanceId: inst.id, taskId: nt.id, nodeId: node.id, operator })
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

  /** issue 29：自动生成标题（对齐 boot3 FlowUtil.addAutoGenTitle） */
  private addAutoGenTitle(displayName: string, vars: Record<string, any>) {
    const realName = vars[KeyRealName] || ''
    const now = new Date()
    const pad = (n: number) => n.toString().padStart(2, '0')
    const timeStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
    vars[KeyAutoGenTitle] = `${realName}的${displayName}-${timeStr}`
  }

  /** 用户提供者访问（issue 41 补强：nodeProgress 姓名解析用） */
  getUserProvider(): UserProvider | undefined {
    return this.userProv
  }

  private nextId(): string {
    if (this.idGen) return this.idGen.nextId()
    return String(Date.now() * 1000 + Math.floor(Math.random() * 1000))
  }
}

// ─── Pure Functions ──────────────────────────────────────────────────────────

/** issues/116：把代理人并入参与者集合——授权人保留、原顺序不动、代理人按参与人顺序追加、去重。
 *  返回新数组（无代理命中时返回原数组引用，零开销）。 */
export function mergeAgents(actors: string[], agents: Map<string, string>): string[] {
  if (agents.size === 0) return actors
  const out = [...actors]
  for (const a of actors) {
    const agent = agents.get(a)
    if (agent && !out.includes(agent)) out.push(agent)
  }
  return out
}

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

/** 实例变量写回合并（issues/97 对齐 Java）：以 base（start 注入的发起人 u_*）为底，
 *  并入执行上下文中**非 u_*** 键（f_ 表单字段 / submitType 等流转数据）。
 *  addUserInfo 生成的操作人 u_* 只属于当次执行上下文与任务行 ext，不整体写回实例——
 *  实例 u_realName 语义是「发起人」（与 autoGenTitle 一致），不随审批节点漂移。 */
function mergeExecIntoInstance(base: Record<string, any>, execVars: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...base }
  for (const [k, v] of Object.entries(execVars)) {
    if (k.startsWith('u_')) continue
    out[k] = v
  }
  return out
}

function isTruthy(v: any): boolean {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') return v !== '' && v !== 'false'
  if (typeof v === 'number') return v !== 0
  return v != null
}

/** 会签判定（issue 42，对齐 Java ProcessTaskPerformTypeEnum.codeOf）：
 *  '1' / 'ALL' / 'COUNTERSIGN'（大小写不敏感）→ 会签。
 *  设计器属性面板保存 'ALL' 字符串符合 Java 契约，引擎必须兼容 */
export function isCountersign(v: any): boolean {
  const s = String(v ?? '').trim().toUpperCase()
  return s === '1' || s === 'ALL' || s === 'COUNTERSIGN'
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
