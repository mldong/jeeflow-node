import {
  type FlowModel, type FlowNode,
  TypeStart, TypeEnd, TypeTask, TypeDecision, TypeFork, TypeJoin, TypeCustom,
  ProcessInstance, type ProcessTask, type ProcessDefine,
  InstanceState, TaskState, SubmitType,
} from './model.js'
import type { ProcessRepository, ProcessExtRepository, UserProvider, IDGenerator, ExpressionEvaluator } from './spi.js'
// issues/141 G2：cc 写侧判重的 java `default` 方法在 TS 里的对应物（第三方仓储未实现判重 SPI 时兜旧行为）
// issues/141 G10：归属值单值/集合归一的**那一份**判据（漏斗层与写侧层共用；issues/142 B 批
// 按 spec 06 §2.11 从"只挂 cc 一支"升为 cc 腿与任务腿共用同一枚，见 spi.normalizeActors）
import { defaultCreateCcInstanceIfAbsent, normalizeActors } from './spi.js'
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
// issues/127：抄送人入参两枚（逐字对齐 Java FlowConst.CC_ACTORS_START / CC_ACTORS）
//   f_ccActors  发起时抄送   tf_ccActors 办理时抄送
export const KeyCcActorsStart = 'f_ccActors'
export const KeyCcActors      = 'tf_ccActors'
// issues/142 A 批：记录类节点（snaker:custom）处理器返回值的**缺省变量键**
// ——逐字对齐 Java `FlowConst.CUSTOM_RETURN_VAL`（enums/FlowConst.java:107）；
// 节点 properties.val 给了就用 val（java CustomParser.java:20-22 的同一判据）。
export const KeyCustomReturnVal = 'custom_return_val'

/**
 * issues/127：归属值入参归一（判据对齐 Java `JeeflowEngineImpl.handleCcActors`）——
 * 数组或逗号串都吃，逐项 trim、丢空项、按出现顺序去重。
 * 去重不是锦上添花：`createCcInstance`/`insertTaskActors` 逐行 INSERT，内存仓那侧还按实例去重，
 * 同一人写两次会"一行两事件"，破掉 §11.3「逐抄送人 fire 一次 ＝ cc 行粒度一一对应」。
 *
 * <p>issues/141 G10「空不创建行」（spec 06 §2.10）：本函数只留**形态**这一层（逗号串 vs 数组），
 * 单值判据交给 `spi.normalizeActors` 那**一份**实现——漏斗层与写侧层（两仓 `createCcInstance`／
 * `addTaskActor` ＋ `defaultCreateCcInstanceIfAbsent`）共用同一条尺子，才不会出现"逗号串修好了、
 * 数组腿漏修"或"门面挡住了、直连仓储照样灌空值"。丢完为空 ⇒ 调用方不建 cc 行、也不 fire 码 4。
 * 反向哨兵同样由那一条判据保证：`"0"` 这类"看起来像空"的正常 id 不会被吃掉。
 *
 * <p>issues/142 B 批（spec 06 §2.11）：本函数从"cc 专用"升为**任务侧与抄送侧共用的形态层**——
 * 门面 `taskAddActor`（addCandidate/surrogate）、`transfer`、`f_`／`tf_nextNodeOperator` 四条腿
 * 都收敛到这里，`parseCcActors` 保留为它的别名（旧导出名不删，见下）。
 * 非数组非字符串（含标量数字）在本形态层按"没有归属人"处理，两仓/两腿同答案。
 */
export function parseActorIds(v: any): string[] {
  const list = Array.isArray(v) ? v : (typeof v === 'string' ? v.split(',') : [])
  return normalizeActors(list)
}

/** issues/142 B 批：{@link parseActorIds} 的旧名（issues/141 G10 起只挂 cc 一支），别名不是第二份判据。 */
export const parseCcActors: (v: any) => string[] = parseActorIds

/**
 * 规范 11 §11.3 载荷键 submitType 归一：出**整数**，不用 undefined（⇒ 省略整键）表达
 * （issues/122 同族坑）。缺省/非法时取引擎既有默认——不认 submitType 的动作一律按同意办
 * （executeNode TypeEnd 分支同样是"非 Reject 即办结"），所以归一成 1(AGREE) 与实际行为一致。
 */
function normalizeSubmitType(v: any): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : SubmitType.Agree
}

/**
 * 规范 11 §11.3 code 5/6 互斥判据（场景 30/31「走退回的这一次不得再发 5」）。
 * 退回族＝2 拒绝 / 3 退回上一步 / 6 退回发起人 / 20 会签软拒绝；
 * 其余（0 APPLY / 1 AGREE / 4 JUMP / 5 重新提交 / 常规会签办理）算"任务被办掉"。
 * ⚠️ 4(JUMP) 按 §11.3 code 5 那一行的"跳转"归 complete：本栈分不出前跳/回跳
 * （要判拓扑），而 §11.3 code 6 的"跳转回退"在 boot2 血缘语义下就是 submitType=3。
 */
function isRejectSubmitType(submitType: number): boolean {
  return submitType === SubmitType.Reject
    || submitType === SubmitType.Rollback
    || submitType === SubmitType.RollbackToOperator
    || submitType === SubmitType.CountersignDisagree
}

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
    // 公开事件发布入口（issues/102 CC_CREATE，issues/127/132 全码表）：引擎内部与各条 fire 腿共用；
    // 无监听器（ext/listeners 为空）时零副作用，与上一版逐字节一致
    await this.#fireEvent(evt)
  }
  async #fireEvent(evt: ProcessEvent) {
    const listeners = this.ext?.listeners
    // 零注册安全返回（§11.5「无监听器」义务：不得空指针/抛错）——ext 未设、listeners 未给、
    // 给了空数组三种形态都走这里，非数组的脏注入同样不炸主流程
    if (!Array.isArray(listeners) || listeners.length === 0) return
    // 兜底语义（issues/104 P2 / §11.5 异常隔离）：**逐监听器** catch——单个监听器抛异常只记日志，
    // ① 不回滚主流程 ② 不中断后续监听器（对齐 PHP per-listener catch；同步抛错也被 await 捕获）
    for (const l of listeners) {
      try {
        await l(evt)
      } catch (e) {
        console.error(`[jeeflow] process event listener error: type=${evt.type} instanceId=${evt.instanceId}`, e)
      }
    }
  }

  /**
   * issues/127 / 规范 11 §11.7：抄送落库 ＋ 逐抄送人 fire CC_CREATE(4) 的**唯一漏斗**。
   * 行为基准＝Java `JeeflowEngineImpl.handleCcActors` + `notifyCcCreate`：
   *   ① 先建 cc 行（落库）② 再按 cc 行粒度逐人 fire，
   *   ccActorId 直传事件体（监听器免反查 cc 表）。
   * 三条路径（发起 f_ccActors／办理 tf_ccActors／手动 processInstance/createCCInstance）
   * 都走本函数 ⇒ §11.2 原则 1「同一事实只发一次、路径不进事件名」；入参为空零副作用。
   *
   * issues/141 G2 写侧判重＝幂等空操作（spec 06 §4）：建行走 `createCcInstanceIfAbsent`，
   * 同一 (实例, 人) 已有 cc 行时跳过——不新增行、不重置未读、不更新原行时间；
   * **逐人 fire 的入参是"实际新建的子集"而不是原始请求**（§11.2 原则 1「码=事实」：
   * 没发生"创建"就不得发码 4），子集为空整支不 fire（不空转、也不照旧全量 fire）。
   * 返回值同步改成那个子集（旧版返回"请求的抄送人"，与"实际新建"不是一回事）。
   * 未实现判重 SPI 的第三方仓储由 `defaultCreateCcInstanceIfAbsent` 兜出旧行为（全量建行＋全量 fire）。
   *
   * issues/141 G10「空不创建行」（spec 06 §2.10）：`parseActorIds` 已把空串/纯空白/数组里的空元素
   * 丢干净，**丢完为空 ⇒ 直接返回、既不建 cc 行也不 fire 码 4**（本栈没有 java 那个
   * `"".split(",")` 得到一个空元素的旧形状）。⚠️ 这一层只是**漏斗**，写侧两仓与
   * `defaultCreateCcInstanceIfAbsent` 各自还要再挡一次——绕过门面/引擎直连仓储的调用方
   * 同样不得把空归属值灌进 `actor_id`（两层缺一层就不算落地）。
   */
  async handleCcActors(instanceId: string, operator: string, ccActors: any): Promise<string[]> {
    const actors = parseActorIds(ccActors)
    if (!actors.length || !instanceId) return actors
    const created = this.repo.createCcInstanceIfAbsent
      ? await this.repo.createCcInstanceIfAbsent(instanceId, operator, ...actors)
      : await defaultCreateCcInstanceIfAbsent(this.repo, instanceId, operator, actors)
    for (const ccActorId of created) {
      await this.fireEvent({ type: EventType.CcCreate, instanceId, operator, ccActorId })
    }
    return created
  }

  /**
   * 规范 11 §11.3 code 2/9 的 fire 漏斗——**必须在实例 state 落库之后调用**（§11.2 原则 3）。
   * 只服务「流程自己走到终点」这一事实：办结(20)/拒绝到终态(45) 共用 PROCESS_INSTANCE_END(2)，
   * 靠载荷 state 分（§11.6：实例终态＝2，旧版 Finish/Reject 拆分作废）；
   * state=40 那一档额外 fire INSTANCE_TERMINATED(9)（规范 08 场景 34）。
   *
   * ⚠️ 撤回(30) **不走本漏斗**——规范 11 §11.3 码 2/8 与场景 32/34 明写「撤回(30)/终止(40)
   * 不发 2，各发 8/9」，同轮既发 8 又发 2 ⇒ 下游收到「流程已办结」的错通知（node 首版即此形状，已纠）。
   *
   * ⚠️ 本栈当前**没有任何写 40 的门面动作**（spec 06 无 processInstance/terminate 档；
   * InstanceState.Interrupt 仅定义、零赋值点），故 code 9 只有经本漏斗才会发得出——
   * 接线是为将来终止腿落地时不再漏发，不是给现有路径凭空多发事件。
   */
  async notifyInstanceEnd(inst: ProcessInstance, operator: string, reason: string = ''): Promise<void> {
    const state = Number(inst.state)
    await this.fireEvent({ type: EventType.ProcessInstanceEnd, instanceId: inst.id, operator, state })
    if (state === InstanceState.Interrupt) {
      await this.fireEvent({ type: EventType.InstanceTerminated, instanceId: inst.id, operator, reason })
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
    // §11.3 code 1：实例行 insert **之后** fire（场景 28：发起前先 fire ⇒ 红）
    await this.fireEvent({ type: EventType.ProcessInstanceStart, instanceId: inst.id, operator })

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
    // issues/127 / 规范 11 §11.7「办理时抄送」腿的统一出口：任务更新已在 prepareExecuteTask
    // 落库，此处建 cc 行并逐人 fire CC_CREATE(4)，再回读实例。
    // 基准＝Java JeeflowEngineImpl.executeProcessTask（node.execute 之后 handleCcActors、
    // 然后 persistTasks）——**每条返回路径都执行**，含会签"未完成即停留"的提前返回，
    // Java 那侧 handleCcActors 同样在这些路径上会跑到。
    const finishExecute = async (): Promise<ProcessInstance> => {
      await this.handleCcActors(inst.id, operator, args[KeyCcActors])
      return (await this.repo.findInstanceById(inst.id))!
    }
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
            // issues/126 案 A · **第五处写点**：这一支绕过 createTask helper 直建任务行，所以必须显式补一次
            // ——基准侧 boot2 的串行推进是回调 createCountersignTask（ProcessTaskServiceImpl:485，
            // 内含 :524 那处到期写）⇒ 基准形状里"推进出的第二/第三位成员"同样带到期时间；
            // 不补就是"首成员有到期、后续没有"（对齐 Java CountersignHandler.applyNodeExpireTime @ cb541d4）。
            // 变量源＝实例变量（与建单同档），取时基准＝本行 createTime 用的同一个 now。
            applyNodeExpireTime(nt, curNode.properties?.expireTime, inst.variables, now)
            await this.repo.saveTask(nt)
            // PROCESS_TASK_START：顺序会签推进新任务落库后 fire（对齐 Java CreateTaskHandler / Rust）
            await this.fireEvent({ type: EventType.ProcessTaskStart, instanceId: inst.id, taskId: nt.id, nodeId: curNode.id, operator, actors: [...nt.actorIds] })
            return finishExecute()
          }
        } else {
          return finishExecute()
        }
      }
      if ((ct === 'PARALLEL' || ct?.startsWith('RATIO')) && !csVeto) {
        const doing = await this.repo.findDoingTasks(inst.id)
        if (doing.length > 0) return finishExecute()
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
    return finishExecute()
  }

  // ─── Reject ────────────────────────────────────────────────────────────────

  async executeAndJumpToEnd(taskId: string, operator: string, args: Record<string, any> = {}): Promise<ProcessInstance> {
    const { inst } = await this.prepareExecuteTask(taskId, operator, args)
    // 门面 submitType=2 REJECT 唯一入口（对齐 Java executeAndJumpToEnd 语义）
    inst.reject(new Date())
    await this.repo.updateInstance(inst)
    // §11.3 code 2：拒绝也是"实例进入终态"（state=45 落库后 fire，靠载荷 state 与办结分家）；
    // "任务被退回"这一事实另由 prepareExecuteTask 的 TASK_REJECT(6) 承载（场景 31/32 两支并存）
    await this.notifyInstanceEnd(inst, operator)
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
          // issues/142（spec 02 §6.1）：往节点上写 assignee 只对**任务类**有意义——java 那侧判据是
          // `tm.getTarget() instanceof TaskModel`（CustomModel 不是 TaskModel 的子类，见
          // JeeflowEngineImpl.executeAndJumpToFirstTaskNode），记录类腿根本不解析参与者，给它写 assignee
          // 等于给一个"本来就不该有参与者"的节点挂人。custom 命中时照样 executeNode（与 java 一样让它
          // 落历史行＋继续走出边），只是不再改写它的 properties。
          if (node.type === TypeTask) {
            node.properties = node.properties ?? {}
            node.properties.assignee = inst.operator
          }
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
    // §11.2 原则 2「码粗、载荷细」＋场景 30/31 互斥：本次动作是"办掉"还是"退回"由 submitType 定，
    // 同一动作只发其中一支（旧形状无论 submitType 一律 fire TaskComplete 即本案病灶）
    const submitType = normalizeSubmitType(vars[KeySubmitType])
    // 聚合根：完成任务（子实体状态转换 + 实例变量合并）
    inst.completeTask(task, operator, vars, now)
    await this.repo.updateTask(task)
    // v1.0.1：updateInstance 级联持久化依赖聚合内任务副本为最新状态，
    // completeTask 改的是外部任务对象，需同步回聚合根
    syncTaskToAggregate(inst, task)

    // issues/97：实例变量写回排除操作人 u_*，保留 start 注入的发起人 u_*（u_realName 恒为发起人）
    inst.variables = mergeExecIntoInstance(baseVars, vars)
    await this.repo.updateInstance(inst)
    // §11.2 原则 3：任务行与实例**都落库之后**才 fire（旧形状排在 updateInstance 之前，
    // 监听器反查实例读到旧状态——与 issues/121/126 两轮"回写序"同族）
    await this.fireEvent({
      type: isRejectSubmitType(submitType) ? EventType.TaskReject : EventType.TaskComplete,
      instanceId: inst.id, taskId: task.id, nodeId: task.taskName, operator, submitType,
    })
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
   * 还会静默留下"实例 DOING 却零待办"）。对外 msg 用固定中文文案、不含引擎内部码（出口统一 99999999）。
   */
  private async rollbackToParent(flow: FlowModel, inst: ProcessInstance,
                                  task: ProcessTask, operator: string): Promise<void> {
    const NO_LINEAGE = '上一步任务ID为空，无法驳回至上一步处理'
    const GUARD = '无法驳回至上一步处理，请确认上一步骤并非fork、join、suprocess以及会签任务'
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
    // 取时基准只取一次：本行 createTime 与 expire_time 共用同一个 Date（写点内不另起时钟）
    const now = new Date()
    const nt = inst.createTask(this.nextId(), prev.id, prev.text.value, actor,
      his.createUser ?? '', prev.properties?.form ?? '', now,
      his.parentTaskId ?? '0', isFirst, his.performType)
    // 复活行只带数据类键：tf_*（上次表单提交）与 csv_*/会签簿记都是"上次提交"的残留
    nt.variables = { ...lineageVars(his.variables), isFirstTaskNode: isFirst }
    // issues/126 案 A · 回退新建写点：表达式取**被回退掉的那个节点**（＝当前节点）的 expireTime，
    // 变量源用随行拷贝那份（boot2 的 hisVariable）——两点都与 Java rejectTask 逐字一致。
    // 取时基准 now 同时是本行 createTime 的值，勿另起时钟（否则同行 create→expire 差值带偏差）。
    applyNodeExpireTime(nt, findNode(flow, task.taskName)?.properties?.expireTime, nt.variables, now)
    const agents = await this.surrogateAgents([actor], await this.surrogateProcessName(flow, inst))
    const eff = mergeAgents([actor], agents)
    if (eff.length > 1) nt.actorIds = eff
    await this.repo.saveTask(nt)
    await this.fireEvent({ type: EventType.ProcessTaskStart, instanceId: inst.id,
      taskId: nt.id, nodeId: prev.id, operator, actors: [...nt.actorIds] })
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
    // issues/126 案 A：与 createTask 同一把尺子。本函数当前**零调用者**（issues/121 P2 把回退改成血缘版后
    // 就没人调它了），按 §1.9 第 1 条口径"接线但不为它造测试"——接线是为了将来复活时不再漏。
    const expireExpr = node.properties?.expireTime
    const expireArgs = inst.variables
    if (isCountersign(node.properties?.performType) && ct) {
      switch (ct) {
        case 'PARALLEL':
        case '':
          for (const actor of actors) {
            const nt = inst.createTask(this.nextId(), node.id, node.text.value, actor, operator, form, now, parentId, isFirst, 1)
            const eff = mergeAgents([actor], agents)
            if (eff.length > 1) nt.actorIds = eff
            applyNodeExpireTime(nt, expireExpr, expireArgs, now)
            await this.repo.saveTask(nt)
            await this.fireEvent({ type: EventType.ProcessTaskStart, instanceId: inst.id, taskId: nt.id, nodeId: node.id, operator, actors: [...nt.actorIds] })
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
          applyNodeExpireTime(nt, expireExpr, expireArgs, now)
          await this.repo.saveTask(nt)
          await this.fireEvent({ type: EventType.ProcessTaskStart, instanceId: inst.id, taskId: nt.id, nodeId: node.id, operator, actors: [...nt.actorIds] })
          return
        }
        default:
          for (const actor of actors) {
            const nt = inst.createTask(this.nextId(), node.id, node.text.value, actor, operator, form, now, parentId, isFirst, 1)
            const eff = mergeAgents([actor], agents)
            if (eff.length > 1) nt.actorIds = eff
            applyNodeExpireTime(nt, expireExpr, expireArgs, now)
            await this.repo.saveTask(nt)
            await this.fireEvent({ type: EventType.ProcessTaskStart, instanceId: inst.id, taskId: nt.id, nodeId: node.id, operator, actors: [...nt.actorIds] })
          }
          return
      }
    }
    const effActors = mergeAgents(actors, agents)
    const nt = inst.createTask(this.nextId(), node.id, node.text.value, effActors[0], operator, form, now, parentId, isFirst)
    if (effActors.length > 1) nt.actorIds = effActors
    applyNodeExpireTime(nt, expireExpr, expireArgs, now)
    await this.repo.saveTask(nt)
    await this.fireEvent({ type: EventType.ProcessTaskStart, instanceId: inst.id, taskId: nt.id, nodeId: node.id, operator, actors: [...nt.actorIds] })
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
    if (node.type === TypeTask) {
      await this.createTask(node, inst, operator, vars, await this.surrogateProcessName(flow, inst),
        parentId, this.isFirstTaskNode(flow, node))
      return
    }
    // issues/142 A 批（spec 02-flow-definition.md §6.1 表第二行 · owner 2026-09-29/09-30 两次拍）：
    // snaker:custom 是**记录类**节点，不是任务类。上一版它与 TypeTask 同路走 createTask ⇒ 落一条
    // DOING 待办行，正是 §6.1「禁止的形状①：当任务类建 DOING 行」。分流后独立一支：执行 clazz、
    // 落 taskState=20 的历史行**并真落库**、令牌沿出边继续流转、不 fire 码 3（详见 execCustomNode）。
    if (node.type === TypeCustom) {
      await this.execCustomNode(flow, inst, node, operator, vars, parentId)
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
        // §11.3 code 2：办结(20)/拒绝(45) 共用 PROCESS_INSTANCE_END，state 落库后 fire（§11.6）
        await this.notifyInstanceEnd(inst, operator)
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
    // issues/142 §6.2 第 3 条（spec 02 §6.1 表第一行 · owner 2026-09-30 拍）：**任务类零参与者也必须建一行
    // DOING**，参与者为空数组。上一版的 `if (!actors.length) return` 就是 §6.1 点名 python 曾犯的死锁黑洞
    // ——实例停在 state=10 却零可办行，谁也办不动。形状与 java `CreateTaskHandler`（handler/impl/
    // CreateTaskHandler.java:38-63 无条件建单）同形。
    // ⚠️ "建行且不挂人"与"不建单"是两件事：这里**严禁**兜底把行挂给当前操作人（§6.1 硬结论 1，八栈一律不许有），
    //    那等于伪造一条他不该收到的待办。记录类（custom）腿已在 executeNode 分流，不再进本函数。
    // 零参与者 ⇒ 会签那三支（逐人建单 / 取 actors[0] / 写 nrOfInstances 簿记）没有成员可循环，
    // 落到下面"普通建单"那一条腿建**一条**空参与者行；簿记键一个都不写，也就没有"计数为 0 会被反复重入"的入口
    // （SEQUENTIAL 的推进只由 nrOfInstances>0 的行驱动，见 executeProcessTask 的 getCsState 那一支）。
    // issues/116：参与者解析完成后、落库前应用生效委托——代理人并入参与者集合，
    // 随任务一起 saveTask 落 wf_process_task_actor（严禁"事后 addTaskActor 补写"）
    const agents = await this.surrogateAgents(actors, processName)
    const ct = node.properties?.countersignType as string | undefined
    const now = new Date()
    const form = node.properties?.form ?? ''
    // issues/126 案 A：节点到期表达式（properties.expireTime）+ 实例变量 + 本函数取时基准 now
    // —— 三处写点（串行首位 / 并行全员 / 普通建单）共用 applyNodeExpireTime 这一把尺子
    const expireExpr = node.properties?.expireTime
    const expireArgs = inst.variables

    // 零参与者 ⇒ 落到下面"普通建单"那一条腿（会签三支都是"按成员逐个建单"，没有成员就没有可建的那一支，
    // 若让它们空跑会重新退化成"零可办行"的黑洞形状）
    if (actors.length && isCountersign(node.properties?.performType) && ct) {
      switch (ct) {
        case 'PARALLEL':
          for (const actor of actors) {
            const nt = inst.createTask(this.nextId(), node.id, node.text.value, actor, operator, form, now, parentId, isFirst, 1)
            const eff = mergeAgents([actor], agents)
            if (eff.length > 1) nt.actorIds = eff
            applyNodeExpireTime(nt, expireExpr, expireArgs, now)   // 并行会签全员
            await this.repo.saveTask(nt)
            // PROCESS_TASK_START：任务落库后逐个 fire（会签多任务逐个，对齐 Java CreateTaskHandler）
            await this.fireEvent({ type: EventType.ProcessTaskStart, instanceId: inst.id, taskId: nt.id, nodeId: node.id, operator, actors: [...nt.actorIds] })
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
          applyNodeExpireTime(nt, expireExpr, expireArgs, now)   // 串行会签首位成员
          await this.repo.saveTask(nt)
          await this.fireEvent({ type: EventType.ProcessTaskStart, instanceId: inst.id, taskId: nt.id, nodeId: node.id, operator, actors: [...nt.actorIds] })
          return
        }
        default:
          for (const actor of actors) {
            const nt = inst.createTask(this.nextId(), node.id, node.text.value, actor, operator, form, now, parentId, isFirst, 1)
            const eff = mergeAgents([actor], agents)
            if (eff.length > 1) nt.actorIds = eff
            applyNodeExpireTime(nt, expireExpr, expireArgs, now)   // 未配会签类型＝全员预创建，与并行同档
            await this.repo.saveTask(nt)
            await this.fireEvent({ type: EventType.ProcessTaskStart, instanceId: inst.id, taskId: nt.id, nodeId: node.id, operator, actors: [...nt.actorIds] })
          }
          return
      }
    }
    // 普通任务：一个任务承载全部参与者（对齐 boot3 createTask + addTaskActor，多参与者任一可办）
    const effActors = mergeAgents(actors, agents)
    // issues/142 §6.2 第 3 条：零参与者时这里照样建**一行**（effActors[0] 不存在 ⇒ 行首人占位写空串，
    // 参与者集合随后被显式赋成空数组），旧形状 `if (!actors.length) return` 已撤。
    const nt = inst.createTask(this.nextId(), node.id, node.text.value, effActors[0] ?? '', operator, form, now, parentId, isFirst)
    // 参与者一律按**有效列表**落库：单人时与工厂默认的 [actor] 等值、多人时并入代理人、零人时是空数组
    // （"建行不挂人"）。写回必须在 saveTask 之前——两仓都是随这一行一起落 wf_process_task_actor。
    nt.actorIds = effActors
    applyNodeExpireTime(nt, expireExpr, expireArgs, now)   // 普通建单
    await this.repo.saveTask(nt)
    await this.fireEvent({ type: EventType.ProcessTaskStart, instanceId: inst.id, taskId: nt.id, nodeId: node.id, operator, actors: [...nt.actorIds] })
  }

  /**
   * 记录类节点（`snaker:custom`）执行腿 —— issues/142 A 批 · spec 02-flow-definition.md §6.1/§6.2
   * （§6.1 owner 2026-09-29 拍「记录类节点没有参与者是正常形态」；§6.2 三条硬要求 owner 2026-09-30 逐条拍）。
   *
   * 三条要求分别落在哪：
   * 1. **历史行必须真落库**（§6.2 第 1 条）——`inst.createHistoryTask(...)` 之后紧跟
   *    `await this.repo.saveTask(ht)`：内存仓进 `tasks` map、SQL 仓走 `INSERT INTO wf_process_task`
   *    （＋ `wf_process_task_actor` 一行），两仓都查得到那条 `task_state=20` 行。
   *    ⚠️ 不照抄 java/c# 的形状：它们把 `createHistoryTask` 的返回值只 append 进聚合 `instance.tasks`，
   *    `persistTasks` 只保存 `exec.getProcessTaskList()`、`updateInstance` 级联又只对
   *    `taskId != null` 的行发 UPDATE ⇒ 那条 DONE 行永远进不了库（§6.2 第 1 条 ⚠️ 段点名基准自身的洞）。
   *    行形状：`taskState=20`、参与者＝`[operator]`（java `Collections.singletonList(operator)` 同形的
   *    **留痕主体**，DONE 行不在待办里出现）、`taskParentId` 与行级 `isFirstTaskNode` 照建单不变量走。
   * 2. **`clazz` 解析不了 ⇒ 记日志 ＋ 照常落历史行 ＋ 令牌继续流转，严禁抛错打断建单**（§6.2 第 2 条）。
   *    "未注册"与"clazz 缺失/空串"**分档两条文案**（c# 把两者合成同一个异常、覆盖面比 java 宽，不照抄）。
   *    反过来处理器**自身执行失败**不在豁免内：不外吞、照旧往上抛，那是业务错误不是配错形状。
   * 3. **本腿不解析参与者**（§6.2 第 3 条前半），所以 §6.1 那条"参与者为空"的判据对它不适用；
   *    任务类零参与者必须建单那一半在 `createTask` 里落地。
   *
   * **不 fire `EventType.ProcessTaskStart`(码 3)**：码 3 表达"新待办产生"（§11.3 那一行明写
   * "每个任务行落库之后逐任务 fire，载荷带 actors"），本腿建出来即已完成态，没有任何待办产生 ——
   * 与 java 一致（java 那侧 `notifyTaskStart` 只跟着 `persistTasks` 的 DOING 行）。
   *
   * `clazz` 的执行形状：TS 没有 java `Class.forName(clazz).newInstance()` 那种反射语义可依托
   * （共享夹具 `flows/08-custom-node.json` 里写的就是 `com.mldong.jeeflow.test.TestCustomHandler`
   * 这种 JVM 类名，在 node 永远反射不到，报"实例化失败"只会把每条沿用夹具的流程都炸掉），
   * 故与 **c#(`Context.CustomHandlers.TryGetValue`) / python(`HandlerRegistry.resolve_custom`) 同策按名查注册表**，
   * 并且**挂在既有 `HandlerRegistry` 上**（本仓的参与者/决策处理器注册表已经是"按名注册＋元数据清单"
   * 两件套，`registerAssignment`/`registerDecision` 同族；另立一个 custom 专用注册中心会造成
   * 第二个并行清单，`listHandlers`/`listHandlerNames` 那两把尺子还得各修一遍）。
   * 返回值非 `undefined` 时写进执行变量，键＝`properties.val`，缺省 `custom_return_val`
   * （对齐 java `CustomParser.java:20-22` 给 `var` 兜的默认值 ＋ `CustomModel.java:46-48` 那句 put）。
   */
  private async execCustomNode(flow: FlowModel, inst: ProcessInstance, node: FlowNode, operator: string,
                               vars: Record<string, any>, parentId: string = '0'): Promise<void> {
    const clazz = String(node.properties?.clazz ?? '').trim()
    const methodName = String(node.properties?.methodName ?? '').trim()
    const handler = clazz ? this.registry?.resolveCustom(clazz) : undefined
    if (handler) {
      // 处理器自身抛错 ⇒ 外抛（§6.2 第 2 条末段：不在"误配不该炸流程"的豁免里）
      const ret = await handler.handle(node, inst, operator, vars)
      const varKey = String(node.properties?.val ?? '').trim() || KeyCustomReturnVal
      if (ret !== undefined) vars[varKey] = ret
    } else if (clazz) {
      // 档 1：clazz 配了、注册表里没有对应实现（本栈按名注册，见方法头注释）。
      // 文案再分两小口：引擎压根没挂 HandlerRegistry 时，集成方照"registerCustom"的提示去查是查不动的。
      console.warn(`[jeeflow] custom 节点 clazz 未注册处理器，跳过执行、只落历史行并继续流转: ` +
        `nodeId=${node.id} clazz=${clazz}${methodName ? ` methodName=${methodName}` : ''}` +
        `（${this.registry
          ? `注册姿势：registry.registerCustom("<clazz 原样串>", handler)`
          : '本引擎实例未挂 HandlerRegistry——先 engine.setRegistry(new HandlerRegistry()) 再 registerCustom("<clazz 原样串>", handler)'}）`)
    } else {
      // 档 2：clazz 根本没配 / 空串 / 纯空白 —— 与档 1 分开诊断（spec 02 §6.2 第 2 条明写要分档）
      console.warn(`[jeeflow] custom 节点未配置 clazz（缺失或空串），跳过执行、只落历史行并继续流转: ` +
        `nodeId=${node.id}（这是流程定义属性问题，不是注册表未命中；判据见 spec 02 §6.2 第 2 条）`)
    }
    const now = new Date()
    const ht = inst.createHistoryTask(this.nextId(), node.id, node.text?.value ?? '', operator, now,
      parentId, this.isFirstTaskNode(flow, node))
    await this.repo.saveTask(ht)
    // 令牌继续沿出边流转（java CustomModel 收尾那句 runOutTransition）
    for (const n of followEdges(flow, node.id)) await this.executeNode(flow, inst, n, operator, vars, parentId)
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
    //    issues/142 B 批（spec 06 §2.11 表第三行）：逗号串与数组**两形同判据**——都收敛到
    //    `parseActorIds` → `spi.normalizeActors` 那一枚单点（逐项 trim、空串/纯空白/null/undefined
    //    丢弃、同次折叠）。改前的两形两样：串腿 `.filter(Boolean)`（JS 假值判据）、数组腿
    //    `map(String)`（null→字面量 "null" 的假归属人、不 trim）。标量档本腿历史上就收
    //    （与 cc 腿不同），保持收单元素但同样过那一判据：数字 0 ⇒ "0" 这个人，不许被当空值丢。
    const nextOp = vars[KeyNextNodeOperator]
    if (nextOp != null) {
      if (typeof nextOp === 'string' || Array.isArray(nextOp)) return parseActorIds(nextOp)
      return normalizeActors([nextOp])
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

// ─── issues/126 案 A · 任务行到期时间（expire_time）求值与写入 ────────────────────

/** 绝对时刻格式 "yyyy-MM-dd HH:mm:ss"（Java SimpleDateFormat / C# TimeFormat 同串） */
const ABS_TIME_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/

/** 按 "yyyy-MM-dd HH:mm:ss" 严格解析（本地时区）；不合规/越界一律 null。
 *  越界判据取 C# 的 TryParseExact（拒 13 月 / 25 时），不取 Java 的 SimpleDateFormat 宽松进位——
 *  本案的硬要求是"解析不出 ⇒ 这一列留空"，宽松进位会把误配的值算成一个真时刻。 */
function parseAbsTime(s: string): Date | null {
  const m = ABS_TIME_RE.exec(s)
  if (!m) return null
  const [, ys, mos, ds, hs, mis, ss] = m
  const mo = Number(mos), d = Number(ds), h = Number(hs), mi = Number(mis), sec = Number(ss)
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || sec > 59) return null
  const dt = new Date(Number(ys), mo - 1, d, h, mi, sec, 0)
  // 2 月 30 日这类"字段合法但日历上不存在"的值会被 JS 进位，回读校验挡掉
  if (dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null
  return dt
}

/** 相对档前缀取整：必须是**纯整数、非负**且落在 int32 内（C# int.TryParse 同判据），否则返回 null ⇒ 落穿。
 *  与 Java 的差异是故意的：Java 的 Integer.parseInt 遇 "xh" 会抛异常**打断建单**，
 *  owner 2026-09-28 定的口径是按 C# 落穿→NULL（配置写错不该让流程卡死）；要改回"跟 Java 一样抛"必须八栈同批改。
 *
 *  issues/137 D（owner 2026-10-01 拍"判非负"，见 jeeflow-doc spec/04 §「相对档前缀必须是非负整数」）：
 *  **负数前缀同样算解析不出** ⇒ 落穿到绝对档 ⇒ 仍解析不出就 NULL。放行 `-5h` 会算出一个**过去**的时刻，
 *  新建的行当场就是逾期——比"没配到期时间"更难发现，也正与本函数上方"任何一档都不许退回当前时间"
 *  （issues/126 的病灶形状）冲突。四个单位档 `s/m/h/d` 共用本函数（processTime 只在下面调一次再按后缀
 *  分发，`d` 档走日历加天不乘 86400，负数＝历日倒退，同病），所以这一处判据把四档一起拦住。
 *
 *  只裁负、**不裁加号**：正则里的 `+` 保留。各栈整数解析（python `[+-]?`、php `[+-]?\d{1,18}`、
 *  java Integer.parseInt）都收 '+'，把它去掉等于新造一处跨栈分叉 ⇒ `+2h` 仍是合法的 now+7200s。
 *
 *  issues/137 E（owner 2026-10-01 拍"统一 trim" · spec 04 §「相对档前缀允许两端空白」，基准＝jeeflow-java
 *  `bf1f401` 的 `Integer.parseInt(text.trim())`）：**判整数之前**先裁掉串的两端空白。理由是各栈整数解析
 *  对空白的容忍度天然不同（go 在 `Atoi` 前显式 `TrimSpace`、rust `.trim()`、python `int()` 与 .NET
 *  `TryParse` 默认就收，本栈的正则校验原本偏偏不吃）⇒ 不裁就是"同一份流程定义在别家有到期时间、这一家没有"
 *  （到期表达式是设计器手填/JSON 搬运的字符串，夹一个空格是常态）。
 *  三条分界（裁的位置**只在传入的前缀切片**，`processTime` 那边取末位单位符的 `charAt` 一律不动）：
 *  ① `" 2h"` / `"2 h"`（空格落在前缀区内、末位仍是单位符）⇒ 裁完照样算得出；
 *  ② `"2h "`（单位符后面还带空白）⇒ 末位是空格、认不出单位 ⇒ 按误配落穿绝对档 ⇒ null，
 *     把整串去空白是另一件没立过法的事，不许顺手做进来；
 *  ③ `" 2.5h"` ⇒ 裁完仍是小数误配 ⇒ 仍落穿 —— trim ≠ "裁容错"。
 *  判负（137 D）位置在裁之后、照常生效：`" -5h"` ⇒ `-5` ⇒ 下面 `n >= 0` 拦下 ⇒ null。
 *  ⚠️ 正则一个字都不改（不塞 `\s*`、`[-+]?` 保留）：判据用的是同一个 `t`，`Number(t)` 也用它，
 *  两处必须吃同一个裁过的串，否则"认得出却转不了"或反之就分叉了。 */
function intPrefix(s: string): number | null {
  const t = s.trim()
  if (!/^[-+]?\d+$/.test(t)) return null
  const n = Number(t)
  return Number.isSafeInteger(n) && n >= 0 && n <= 2147483647 ? n : null
}

/**
 * 解析期待完成时间（逐字移植 Java `FlowUtil.processTime` / C# `FlowUtil.ProcessTime`，本栈原先没有）。
 *
 * 三档语义，**顺序不能变**：
 *  1. `args` 里存在键名等于 expr 原串的项 ⇒ 取该项的值：Date / 毫秒时间戳 / `"yyyy-MM-dd HH:mm:ss"`
 *     → 该时刻；字符串解析失败 → **null**（不是 now）；其它类型（布尔/数组/对象/小数）→ **落穿**到下面两档
 *     （Java/C# 都是落穿，不许当"解析失败"提前 return null）。
 *  2. 否则 expr 以 `s`/`m`/`h`/`d` 结尾且前缀是整数 ⇒ now + N 秒/分/时/天（`d` 走**日历加天**，不乘 86400 秒）。
 *     前缀**允许两端空白**（issues/137 E · owner 拍"统一 trim"）：`intPrefix` 在判整数前裁掉
 *     `expr.slice(0, -1)` 的两端空白 ⇒ `" 2h"`、`"2 h"` 照样算得出；裁的边界只到前缀，末位单位符那一位
 *     （下面 `expr.charAt(expr.length - 1)`）**不跟着 trim** ⇒ `"2h "` 仍按误配落穿。
 *  3. 否则把 expr 本身按 `"yyyy-MM-dd HH:mm:ss"` 解析 → 时刻；失败 → null。
 *     ⚠️ 档 1 的键名与档 3 的串本身**都不 trim**：那是键名/时间串本身，裁它会改的是另一件事。
 *
 * ⚠️ 任何一档都不得退回 now()——"算不出来就写当前时间"正是 issues/126 的病灶（建单即逾期，逾期统计恒失真）。
 *
 * @param now 取时基准＝**本栈写 createTime 用的同一个 Date**（本栈无时钟槽，与 Java 直接用系统钟同档）
 */
export function processTime(expr: string, args: Record<string, any> | undefined, now: Date): Date | null {
  const a = args ?? {}
  // ① 变量档：优先于相对档（args 里真有个键叫 "2h" 时取变量值）
  if (Object.prototype.hasOwnProperty.call(a, expr)) {
    const v = a[expr]
    if (v instanceof Date) return new Date(v.getTime())
    if (typeof v === 'number' && Number.isSafeInteger(v)) return new Date(v)
    if (typeof v === 'string') return parseAbsTime(v)
    // 其它类型 ⇒ 落穿
  }
  if (expr.trim() === '') return null
  // ② 相对档
  const n = intPrefix(expr.slice(0, -1))
  if (n !== null) {
    switch (expr.charAt(expr.length - 1)) {
      case 's': return new Date(now.getTime() + n * 1000)
      case 'm': return new Date(now.getTime() + n * 60000)
      case 'h': return new Date(now.getTime() + n * 3600000)
      case 'd': {
        const d = new Date(now.getTime())
        d.setDate(d.getDate() + n)   // 日历加天（跨夏令时/月末按天进位，对齐 Java Calendar.add）
        return d
      }
      default: break
    }
  }
  // ③ 绝对档
  return parseAbsTime(expr)
}

/**
 * issues/126 案 A · 任务行 expire_time 的**唯一**写入口（五处写点共用同一把尺子）：
 * 普通建单 / 串行会签首位成员 / 并行会签全员 / 回退新建 / 串行会签推进出的下一位成员。
 *
 * 节点没配（undefined / null / 空串 / 纯空白）⇒ **该列保持空**：不写 now()、不写 ''、不写 0
 * （owner 2026-09-28 口径，对齐 boot2 `if(StrUtil.isNotEmpty(expireTime))` 的先判再写）。
 *
 * 变量源两档：建单路径＝**实例变量**（boot2 的 `execution.getArgs()`），
 * 回退新建＝**随行拷贝那份变量**（boot2 的 `hisVariable`）。搞混会让"表达式是个变量名"这一档跨栈得到不同答案。
 */
function applyNodeExpireTime(task: ProcessTask, expr: unknown, args: Record<string, any> | undefined, now: Date): void {
  if (!task) return
  const s = expr == null ? '' : String(expr)
  if (s.trim() === '') return
  const at = processTime(s, args, now)
  if (at) task.expireTime = at
}
