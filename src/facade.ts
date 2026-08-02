// 统一门面（v1.1.0）——"接口即 POST + JSON body"风格的单入口
//
// 集成方只实现一个转发端点：把 body JSON 转成对象传入 flow()，所有流程能力按
// action（boot2/boot3 端点短名）路由。返回统一结构 {code, msg, data}
// （code=0 成功 / 99999999 失败）。操作人约定：args.operator 显式传入。

import {
  InstanceState, ProcessDefine, ProcessDesign, ProcessDesignHis, ProcessSurrogate,
  TaskState,
} from './model.js'
import type { ProcessExtRepository, ProcessRepository } from './spi.js'
import type { EngineImpl } from './engine.js'

// submitType 枚举（对齐 boot3）
const SUBMIT_APPLY = 0
const SUBMIT_AGREE = 1
const SUBMIT_REJECT = 2
const SUBMIT_ROLLBACK = 3
const SUBMIT_JUMP = 4
const SUBMIT_ROLLBACK_TO_OPERATOR = 6
const SUBMIT_COUNTERSIGN_DISAGREE = 20

export type UserSearch = (query: Record<string, any>) => Promise<[Record<string, any>[], number]> | [Record<string, any>[], number]

export class JeeflowFacade {
  private userSearch?: UserSearch

  constructor(
    private readonly engine: EngineImpl,
    private readonly repo: ProcessRepository,
    private readonly extRepo?: ProcessExtRepository,
  ) {}

  // 注入用户搜索钩子（candidatePage 无模型候选时的用户分页搜索）
  setUserSearch(fn: UserSearch): this {
    this.userSearch = fn
    return this
  }

  async flow(action: string, args: Record<string, any> = {}): Promise<Record<string, any>> {
    try {
      const data = await this.dispatch(action, args)
      return { code: 0, msg: '成功', data: data ?? null }
    } catch (e: any) {
      return { code: 99999999, msg: e?.message ?? String(e) }
    }
  }

  private async dispatch(action: string, args: Record<string, any>): Promise<any> {
    switch (action) {
      case 'processDefine/page':
        return this.definePage(args)
      case 'processDefine/detail':
        return this.defineDetail(args)
      case 'processDefine/startAndExecute':
      case 'processInstance/startAndExecute':
        return this.startAndExecute(args)
      case 'processDefine/deploy':
      case 'processDesign/deploy':
        return this.deploy(args, action === 'processDesign/deploy')
      case 'processDefine/redeploy':
        return this.redeploy(args)
      case 'processDefine/remove':
        return this.repo.removeDefine(toId(args.id))
      case 'processDefine/upAndDown':
        return this.repo.updateDefineState(toId(args.id), toInt(args.state))
      case 'processInstance/page':
        return this.instancePage(args)
      case 'processInstance/detail':
        return this.instanceDetail(args)
      case 'processInstance/withdraw':
        return this.withdraw(args)
      case 'processTask/todoList':
        return this.todoList(args)
      case 'processTask/doneList':
        return this.doneList(args)
      case 'processTask/execute':
        return this.execute(args)
      case 'processDesign/page':
        return this.designPage(args)
      case 'processDesign/detail':
        return this.designDetail(args)
      case 'processDesign/save':
        return this.designSave(args)
      case 'processDesign/remove':
        return this.ext().removeDesign(toId(args.id))
      case 'processSurrogate/page':
        return this.surrogatePage(args)
      case 'processSurrogate/save':
        return this.surrogateSave(args)
      case 'processSurrogate/remove':
        return this.ext().removeSurrogate(toId(args.id))
      case 'processDefine/getLastByName':
        return this.getLastByName(args)
      case 'processInstance/highLight':
        return this.highLight(args)
      case 'processInstance/approvalRecord':
        return this.approvalRecord(args)
      case 'processInstance/getAssigneeTextData':
        return this.getAssigneeTextData(args)
      case 'processInstance/createCCInstance':
        return this.createCCInstance(args)
      case 'processInstance/updateCCStatus':
        return this.updateCCStatus(args)
      case 'processInstance/ccList':
        return this.ccList(args)
      case 'processTask/detail':
        return this.taskDetail(args)
      case 'processTask/jumpAbleTaskNameList':
        return this.jumpAbleTaskNameList(args)
      case 'processTask/candidatePage':
        return this.candidatePage(args)
      case 'processTask/surrogate':
      case 'processTask/addCandidate':
        return this.taskAddActor(args)
      case 'processTask/latest':
        return this.taskLatest(args)
      default:
        throw new Error(`未知 action: ${action}`)
    }
  }

  // ── 流程定义 / 实例 ──────────────────────────────────────────────────────

  private async startAndExecute(args: Record<string, any>): Promise<Record<string, any>> {
    const defineId = toId(args.processDefineId)
    const operator = String(args.operator ?? 'user1')
    const flowArgs: Record<string, any> = {}
    for (const [k, v] of Object.entries(args)) {
      if (k === 'processDefineId' || k === 'operator') continue
      flowArgs[k] = v
    }
    const inst = await this.engine.startProcessInstanceById(defineId, operator, flowArgs)
    // startAndExecute：自动完成申请节点（assignee="applicant" → 发起人）
    const doing = await this.repo.findDoingTasks(inst.id)
    for (const task of doing) {
      await this.repo.addTaskActor(task.id, [operator])
      flowArgs.submitType = SUBMIT_APPLY
      await this.engine.executeProcessTask(task.id, operator, flowArgs)
    }
    return { processInstanceId: inst.id }
  }

  // deploy 版本管理（对齐 boot3）：按 name 查最新定义，存在 version+1 插新记录，否则从 0 起
  private async deploy(args: Record<string, any>, fromDesign: boolean): Promise<Record<string, any>> {
    let content: string
    if (fromDesign) {
      const designId = toId(args.id)
      const ext = this.ext()
      const design = await ext.findDesignById(designId)
      if (!design) throw new Error('流程设计不存在')
      const hisList = await ext.listDesignHis(designId)
      if (hisList.length === 0) throw new Error('流程设计没有内容，无法发布')
      content = toStr(hisList[0].content)
      const defineId = await this.saveDeployedDefine(content, args)
      design.isDeployed = 1
      design.updateUser = String(args.operator ?? 'system')
      await ext.updateDesign(design)
      return { processDefineId: defineId }
    }
    content = toStr(args.content)
    const defineId = await this.saveDeployedDefine(content, args)
    return { processDefineId: defineId }
  }

  private async saveDeployedDefine(content: string, args: Record<string, any>): Promise<number> {
    let flow: any
    try {
      flow = JSON.parse(content)
    } catch {
      throw new Error('流程定义 JSON 解析失败')
    }
    const name = flow?.name
    if (!name) throw new Error('流程定义缺少 name')
    let version = 0
    const latest = await this.repo.findDefineByName(name)
    if (latest) version = (latest.version ?? 0) + 1
    const operator = String(args.operator ?? 'system')
    const def: ProcessDefine = {
      id: 0, name, displayName: flow.displayName ?? '', type: flow.type ?? 'approval',
      state: 1, content, version, createTime: new Date(), createUser: operator,
      updateTime: new Date(), updateUser: operator,
    }
    await this.repo.saveDefine(def)
    return def.id
  }

  private async redeploy(args: Record<string, any>): Promise<void> {
    const defineId = toId(args.processDefineId)
    const content = toStr(args.content)
    let flow: any
    try {
      flow = JSON.parse(content)
    } catch {
      throw new Error('流程定义 JSON 解析失败')
    }
    await this.repo.updateDefine({
      id: defineId, name: flow?.name ?? '', displayName: flow?.displayName ?? '',
      type: flow?.type ?? 'approval', state: 1, content, version: 0,
      createTime: new Date(), createUser: '', updateTime: new Date(),
      updateUser: String(args.operator ?? 'system'),
    })
  }

  private async withdraw(args: Record<string, any>): Promise<void> {
    const instanceId = toId(args.id)
    const inst = await this.repo.findInstanceById(instanceId)
    if (!inst) throw new Error('流程实例不存在')
    // 撤回：废弃全部 doing 任务 + 实例状态（v1.0.1：updateInstance 级联落库）
    const operator = String(args.operator ?? 'user1')
    const now = new Date()
    const abandoned = inst.abandonAllDoing(now)
    inst.reject(now)
    inst.updateUser = operator
    for (const t of abandoned) await this.repo.updateTask(t)
    await this.repo.updateInstance(inst)
  }

  // ── 流程任务 ─────────────────────────────────────────────────────────────

  private async execute(args: Record<string, any>): Promise<void> {
    const taskId = toId(args.processTaskId)
    const operator = String(args.operator ?? 'user1')
    const submitType = toInt(args.submitType ?? SUBMIT_AGREE)
    const flowArgs: Record<string, any> = {}
    for (const [k, v] of Object.entries(args)) {
      if (k === 'processTaskId' || k === 'operator') continue
      flowArgs[k] = v
    }
    flowArgs.submitType = submitType
    // boot3 execute 分发（spec §11.2）
    switch (submitType) {
      case SUBMIT_REJECT:
        await this.engine.executeAndJumpToEnd(taskId, operator, flowArgs)
        break
      case SUBMIT_ROLLBACK:
        await this.engine.executeAndJumpTask(taskId, operator, flowArgs, '')
        break
      case SUBMIT_JUMP:
        await this.engine.executeAndJumpTask(taskId, operator, flowArgs, String(args.taskName ?? ''))
        break
      case SUBMIT_ROLLBACK_TO_OPERATOR:
        await this.engine.executeAndJumpToFirstTaskNode(taskId, operator, flowArgs)
        break
      case SUBMIT_COUNTERSIGN_DISAGREE:
        flowArgs.countersignDisagreeFlag = 1
        await this.engine.executeProcessTask(taskId, operator, flowArgs)
        break
      default: // 0 APPLY / 1 AGREE / 5 重新提交
        await this.engine.executeProcessTask(taskId, operator, flowArgs)
    }
  }

  // ── 流程设计（需扩展仓储） ───────────────────────────────────────────────

  private async designPage(args: Record<string, any>): Promise<Record<string, any>> {
    const [rows, total] = await this.ext().pageDesigns(toInt(args.pageNum ?? 1), toInt(args.pageSize ?? 10))
    return { rows, recordCount: total }
  }

  private async designDetail(args: Record<string, any>): Promise<Record<string, any>> {
    const ext = this.ext()
    const design = await ext.findDesignById(toId(args.id))
    if (!design) throw new Error('流程设计不存在')
    const data: Record<string, any> = {
      id: design.id, name: design.name, displayName: design.displayName,
      type: design.type, icon: design.icon, isDeployed: design.isDeployed, remark: design.remark,
    }
    const hisList = await ext.listDesignHis(design.id)
    if (hisList.length > 0) {
      try {
        data.jsonObject = JSON.parse(toStr(hisList[0].content))
      } catch { /* ignore */ }
    }
    data.his = hisList
    return data
  }

  private async designSave(args: Record<string, any>): Promise<Record<string, any>> {
    const ext = this.ext()
    const operator = String(args.operator ?? 'user1')
    const designId = args.id != null ? toId(args.id) : 0
    let design: ProcessDesign
    if (!designId) {
      design = {
        id: 0, name: String(args.name ?? ''), displayName: String(args.displayName ?? ''),
        type: String(args.type ?? 'approval'), icon: String(args.icon ?? ''),
        isDeployed: 0, remark: String(args.remark ?? ''),
        createTime: new Date(), createUser: operator,
        updateTime: new Date(), updateUser: operator,
      }
      await ext.saveDesign(design)
    } else {
      const found = await ext.findDesignById(designId)
      if (!found) throw new Error('流程设计不存在')
      if (args.displayName != null) found.displayName = String(args.displayName)
      if (args.type != null) found.type = String(args.type)
      if (args.icon != null) found.icon = String(args.icon)
      if (args.remark != null) found.remark = String(args.remark)
      found.updateUser = operator
      await ext.updateDesign(found)
      design = found
    }
    // 内容快照（设计稿内容存历史表）
    if (args.content != null) {
      await ext.saveDesignHis({
        id: 0, processDesignId: design.id, content: String(args.content),
        createTime: new Date(), createUser: operator,
      })
    }
    return { id: design.id }
  }

  // ── 委托代理（需扩展仓储） ───────────────────────────────────────────────

  private async surrogatePage(args: Record<string, any>): Promise<Record<string, any>> {
    const filters = args.operator != null ? { operator: String(args.operator) } : undefined
    const [rows, total] = await this.ext().pageSurrogates(
      toInt(args.pageNum ?? 1), toInt(args.pageSize ?? 10), filters)
    return { rows, recordCount: total }
  }

  private async surrogateSave(args: Record<string, any>): Promise<Record<string, any>> {
    const ext = this.ext()
    const operator = String(args.operator ?? 'user1')
    const surrogateId = args.id != null ? toId(args.id) : 0
    let surrogate: ProcessSurrogate
    if (!surrogateId) {
      surrogate = {
        id: 0, operator, // 授权人 = 操作人
        surrogate: String(args.surrogate ?? ''), processName: String(args.processName ?? ''),
        enabled: toInt(args.enabled ?? 1),
        createTime: new Date(), createUser: operator,
        updateTime: new Date(), updateUser: operator,
      }
      await ext.saveSurrogate(surrogate)
    } else {
      const found = await ext.findSurrogateById(surrogateId)
      if (!found) throw new Error('委托记录不存在')
      if (args.surrogate != null) found.surrogate = String(args.surrogate)
      if (args.processName != null) found.processName = String(args.processName)
      if (args.enabled != null) found.enabled = toInt(args.enabled)
      found.updateUser = operator
      await ext.updateSurrogate(found)
      surrogate = found
    }
    return { id: surrogate.id }
  }

  // ── 视图端点（v1.2.0） ──────────────────────────────────────────────────

  private async getLastByName(args: Record<string, any>): Promise<any> {
    const def = await this.repo.findDefineByName(String(args.processDefineName ?? ''))
    if (!def) throw new Error(`流程定义不存在: ${args.processDefineName}`)
    return { id: def.id, name: def.name, displayName: def.displayName, type: def.type, state: def.state, version: def.version }
  }

  private async highLight(args: Record<string, any>): Promise<any> {
    const instanceId = toId(args.id)
    const inst = await this.repo.findInstanceById(instanceId)
    if (!inst) throw new Error('流程实例不存在')
    const active: string[] = []
    const history: string[] = []
    const edges: string[] = []
    const doing = await this.repo.findDoingTasks(instanceId)
    for (const t of doing) if (!active.includes(t.taskName)) active.push(t.taskName)
    const his = await this.repo.findHistoryTasks(instanceId)
    for (const t of his) if (!active.includes(t.taskName) && !history.includes(t.taskName)) history.push(t.taskName)
    // 路径补全：start 沿边递归（遇活跃节点停止）；决策分支按表达式求值过滤（issues/06）
    const def = await this.repo.findDefineById(inst.defineId)
    if (def) {
      try {
        const flow = JSON.parse(toStr(def.content))
        await this.collectPath(flow, 'start', '', active, history, edges, new Set(), inst.variables ?? {}, his)
      } catch { /* ignore */ }
    }
    return { activeNodeNames: active, historyNodeNames: history, historyEdgeNames: edges }
  }

  private async collectPath(flow: any, nodeId: string, edgeName: string, active: string[],
    history: string[], edges: string[], visited: Set<string>,
    vars: Record<string, any>, historyTasks: any[]): Promise<void> {
    if (visited.has(nodeId)) return
    visited.add(nodeId)
    if (edgeName && !edges.includes(edgeName)) edges.push(edgeName)
    const src = (flow.nodes ?? []).find((n: any) => n.id === nodeId)
    for (const e of flow.edges ?? []) {
      if (e.sourceNodeId !== nodeId) continue
      // 决策节点：输出边表达式求值过滤（对齐 boot3 recursionModel，issues/06）
      if (src?.type === 'snaker:decision') {
        const expr = e.properties?.expr
        if (expr && !await this.evalDecisionExpr(flow, src, expr, vars, historyTasks)) continue
      }
      const target = (flow.nodes ?? []).find((n: any) => n.id === e.targetNodeId)
      if (!target) continue
      const tid = target.id
      if (!active.includes(tid) && !history.includes(tid)) history.push(tid)
      if (active.includes(tid)) continue
      await this.collectPath(flow, tid, e.id, active, history, edges, visited, vars, historyTasks)
    }
  }

  /** 决策输出边表达式求值（args = 实例变量 + 决策节点前置任务变量） */
  private async evalDecisionExpr(flow: any, decision: any, expr: string,
    vars: Record<string, any>, historyTasks: any[]): Promise<boolean> {
    const args: Record<string, any> = { ...(vars ?? {}) }
    for (const e of flow.edges ?? []) {
      if (e.targetNodeId === decision.id) {
        const t = (historyTasks ?? []).find((x: any) => x.taskName === e.sourceNodeId)
        if (t?.variables) Object.assign(args, t.variables)
        break
      }
    }
    try {
      return Boolean(await this.engine.evalExpr(expr, args))
    } catch {
      return false
    }
  }

  private async approvalRecord(args: Record<string, any>): Promise<any> {
    const instanceId = toId(args.id)
    const his = await this.repo.findHistoryTasks(instanceId)
    return his.map(t => ({
      taskName: t.taskName, displayName: t.displayName, taskType: t.taskType ?? null,
      performType: t.performType ?? null, taskState: t.taskState, operator: t.actorId ?? '',
      finishTime: t.finishTime ?? null, variable: t.variables ?? {},
    }))
  }

  private async getAssigneeTextData(args: Record<string, any>): Promise<any> {
    const instanceId = toId(args.id)
    const includeNodeName = args.includeNodeName !== false
    const rows: Record<string, any>[] = []
    const doing = await this.repo.findDoingTasks(instanceId)
    for (const t of doing) {
      const actors = await this.repo.findTaskActors(t.id)
      for (const actor of actors) {
        rows.push({ label: includeNodeName ? `${t.displayName}:${actor}` : actor, value: actor })
      }
    }
    return rows
  }

  private async createCCInstance(args: Record<string, any>): Promise<void> {
    const instanceId = toId(args.processInstanceId)
    const operator = String(args.operator ?? 'user1')
    const actors = toStringList2(args.actorIds)
    if (actors.length === 0) throw new Error('actorIds 缺失')
    await this.repo.createCcInstance(instanceId, operator, ...actors)
  }

  private async updateCCStatus(args: Record<string, any>): Promise<void> {
    const instanceId = toId(args.processInstanceId)
    const operator = String(args.operator ?? 'user1')
    await this.repo.updateCcStatus(instanceId, operator)
  }

  // ccList 我的抄送分页（v1.3.0）：operator 作为抄送人过滤
  private async ccList(args: Record<string, any>): Promise<Record<string, any>> {
    const pageNum = toInt(args.pageNum ?? 1)
    const pageSize = toInt(args.pageSize ?? 10)
    const actorId = String(args.operator ?? 'user1')
    const { rows, total } = await this.repo.pageCcInstances(pageNum, pageSize, actorId)
    return { rows, recordCount: total }
  }

  private async taskDetail(args: Record<string, any>): Promise<any> {
    const taskId = toId(args.id)
    const operator = String(args.operator ?? 'user1')
    const task = await this.repo.findTaskById(taskId)
    if (!task) throw new Error('任务不存在')
    const actors = await this.repo.findTaskActors(taskId)
    const vo: Record<string, any> = {
      id: task.id, processInstanceId: task.processInstanceId, taskName: task.taskName,
      displayName: task.displayName, taskType: task.taskType ?? null,
      performType: task.performType ?? null, taskState: task.taskState,
      operator: task.actorId ?? '', formKey: task.formKey ?? '',
      taskActorIdList: actors, executable: task.isAllowed(operator),
    }
    // taskModel：流程定义中对应节点
    const inst = await this.repo.findInstanceById(task.processInstanceId)
    if (inst) {
      const def = await this.repo.findDefineById(inst.defineId)
      if (def) {
        try {
          const flow = JSON.parse(toStr(def.content))
          for (const n of flow.nodes ?? []) {
            if (n.id === task.taskName) {
              vo.taskModel = { name: n.id, displayName: n.text?.value ?? '', type: n.type }
              break
            }
          }
        } catch { /* ignore */ }
      }
    }
    return vo
  }

  private async jumpAbleTaskNameList(args: Record<string, any>): Promise<any> {
    const instanceId = toId(args.processInstanceId)
    const done = await this.repo.findDoneTasks(instanceId)
    const rows: Record<string, any>[] = []
    const seen = new Set<string>()
    for (const t of done) {
      if ((t.performType ?? 0) === 1) continue // COUNTERSIGN
      if (!seen.has(t.taskName)) {
        seen.add(t.taskName)
        rows.push({ label: t.displayName, value: t.taskName })
      }
    }
    return rows
  }

  private async candidatePage(args: Record<string, any>): Promise<any> {
    const taskId = toId(args.processTaskId ?? args.id)
    const task = await this.repo.findTaskById(taskId)
    if (!task) throw new Error('任务不存在')
    const inst = await this.repo.findInstanceById(task.processInstanceId)
    if (!inst) throw new Error('流程实例不存在')
    // 模型候选解析：后继任务节点的 candidateUsers 配置
    let candidates: string[] = []
    const def = await this.repo.findDefineById(inst.defineId)
    if (def) {
      try {
        const flow = JSON.parse(toStr(def.content))
        candidates = this.nextTaskCandidates(flow, task.taskName)
      } catch { /* ignore */ }
    }
    if (candidates.length > 0) {
      const rows = candidates.map(c => ({ userId: c, realName: c }))
      return { rows, recordCount: rows.length }
    }
    // 无模型候选 → 用户分页搜索（依赖 userSearch 钩子）
    if (!this.userSearch) throw new Error('未配置 userSearch（用户搜索钩子）')
    const [rows, total] = await this.userSearch(args)
    return { rows, recordCount: total }
  }

  private nextTaskCandidates(flow: any, taskName: string): string[] {
    const result: string[] = []
    const visited = new Set<string>()
    const collect = (node: any) => {
      const v = node.properties?.candidateUsers
      if (v) {
        for (const s of String(v).split(',')) {
          const t = s.trim()
          if (t && !result.includes(t)) result.push(t)
        }
      }
    }
    const walk = (nodeId: string) => {
      if (visited.has(nodeId)) return
      visited.add(nodeId)
      for (const e of flow.edges ?? []) {
        if (e.sourceNodeId !== nodeId) continue
        const target = (flow.nodes ?? []).find((n: any) => n.id === e.targetNodeId)
        if (!target) continue
        if (target.type === 'snaker:task' || target.type === 'snaker:custom') {
          collect(target)
          continue
        }
        if (['snaker:fork', 'snaker:join', 'snaker:decision'].includes(target.type)) {
          walk(target.id)
        }
      }
    }
    walk(taskName)
    return result
  }

  private async taskAddActor(args: Record<string, any>): Promise<void> {
    const taskId = toId(args.processTaskId)
    const actors = toStringList2(args.actorIds)
    if (actors.length === 0) throw new Error('actorIds 缺失')
    await this.repo.addTaskActor(taskId, actors)
  }

  private async taskLatest(args: Record<string, any>): Promise<any> {
    const instanceId = toId(args.processInstanceId)
    const doing = await this.repo.findDoingTasks(instanceId)
    if (doing.length === 0) return null
    const t = doing[0]
    return { id: t.id, taskName: t.taskName, displayName: t.displayName, taskState: t.taskState, operator: t.actorId ?? '' }
  }

  private ext(): ProcessExtRepository {
    if (!this.extRepo) throw new Error('未配置 ProcessExtRepository（扩展仓储）')
    return this.extRepo
  }
  // ═══ 基础分页/详情（v1.5.0 补齐，对齐 Java 门面）═══

  private async definePage(args: Record<string, any>): Promise<Record<string, any>> {
    const pageNum = toInt(args.pageNum ?? 1)
    const pageSize = toInt(args.pageSize ?? 10)
    const { rows, total } = await this.repo.pageDefines(pageNum, pageSize)
    return { rows, recordCount: total }
  }

  private async defineDetail(args: Record<string, any>): Promise<Record<string, any>> {
    const id = toId(args.id)
    const def = await this.repo.findDefineById(id)
    if (!def) throw new Error('流程定义不存在')
    return {
      id: def.id, name: def.name, displayName: def.displayName,
      type: def.type, state: def.state, version: def.version,
    }
  }

  private async instancePage(args: Record<string, any>): Promise<Record<string, any>> {
    const pageNum = toInt(args.pageNum ?? 1)
    const pageSize = toInt(args.pageSize ?? 10)
    const operator = String(args.operator ?? 'user1')
    const { rows, total } = await this.repo.pageInstances(pageNum, pageSize, operator)
    return { rows, recordCount: total }
  }

  private async instanceDetail(args: Record<string, any>): Promise<Record<string, any>> {
    const id = toId(args.id)
    const inst = await this.repo.findInstanceById(id)
    if (!inst) throw new Error('流程实例不存在')
    return {
      id: inst.id, parentId: inst.parentId, processDefineId: inst.defineId,
      state: inst.state, parentNodeName: inst.parentNodeName,
      businessNo: inst.businessNo, operator: inst.operator,
      variables: inst.variables, createTime: inst.createTime, createUser: inst.createUser,
      tasks: (inst.tasks ?? []).map(t => ({
        id: t.id, processInstanceId: t.processInstanceId, taskName: t.taskName,
        displayName: t.displayName, taskType: t.taskType, performType: t.performType,
        taskState: t.taskState, operator: t.actorId ?? '', finishTime: t.finishTime,
        expireTime: t.expireTime, formKey: t.formKey ?? '', taskParentId: t.parentTaskId ?? null,
        variable: JSON.stringify(t.variables ?? {}),
        createTime: t.createTime, createUser: t.createUser,
        updateTime: t.updateTime, updateUser: t.updateUser,
        taskActorIdList: t.actorIds ?? [],
      })),
    }
  }

  private async todoList(args: Record<string, any>): Promise<Record<string, any>> {
    const pageNum = toInt(args.pageNum ?? 1)
    const pageSize = toInt(args.pageSize ?? 10)
    const actorId = String(args.operator ?? 'user1')
    const { rows, total } = await this.repo.pageTodoTasks(pageNum, pageSize, actorId)
    return { rows, recordCount: total }
  }

  private async doneList(args: Record<string, any>): Promise<Record<string, any>> {
    const pageNum = toInt(args.pageNum ?? 1)
    const pageSize = toInt(args.pageSize ?? 10)
    const operator = String(args.operator ?? 'user1')
    const { rows, total } = await this.repo.pageDoneTasks(pageNum, pageSize, operator)
    return { rows, recordCount: total }
  }

}

// ── 工具 ──────────────────────────────────────────────────────────────────────

function toStr(v: any): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (v instanceof Uint8Array || Buffer.isBuffer(v)) return Buffer.from(v).toString('utf8')
  return String(v)
}

function toId(v: any): number {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) throw new Error('id 缺失或非法')
  return n
}

function toStringList2(v: any): string[] {
  if (Array.isArray(v)) return v.map(String)
  if (typeof v === 'string') return v.split(',').map(s => s.trim()).filter(Boolean)
  return []
}

function toInt(v: any): number {
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error('数值缺失或非法')
  return n
}
