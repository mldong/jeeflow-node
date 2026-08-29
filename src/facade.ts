// 统一门面（v1.1.0）——"接口即 POST + JSON body"风格的单入口
//
// 集成方只实现一个转发端点：把 body JSON 转成对象传入 flow()，所有流程能力按
// action（boot2/boot3 端点短名）路由。返回统一结构 {code, msg, data}
// （code=0 成功 / 99999999 失败）。操作人约定：args.operator 显式传入。

import {
  CcInstanceRow, DefineRow, InstanceRow, InstanceState, ProcessDefine, ProcessDesign,
  ProcessDesignHis, ProcessSurrogate, ProcessTask, TaskRow, TaskState,
} from './model.js'
import type { OrgUserProvider, ProcessExtRepository, ProcessRepository, QueryCondition } from './spi.js'
import type { EngineImpl } from './engine.js'
import { KeyNextNodeOperator, KeyProcessStartNextNodeOperator, isCountersign } from './engine.js'

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
  private orgProv?: OrgUserProvider

  private metaReader?: { readByProcessInstance(tableName: string, processInstanceId: unknown): unknown }

  constructor(
    private readonly engine: EngineImpl,
    private readonly repo: ProcessRepository,
    private readonly extRepo?: ProcessExtRepository,
  ) {}

  /** 注入业务数据读取器（issue 30）：需有 readByProcessInstance(tableName, processInstanceId) */
  setMetaReader(reader: { readByProcessInstance(tableName: string, processInstanceId: unknown): unknown }): this {
    this.metaReader = reader
    return this
  }

  // 注入用户搜索钩子（candidatePage 无模型候选时的用户分页搜索）
  setUserSearch(fn: UserSearch): this {
    this.userSearch = fn
    return this
  }

  // 注入组织用户提供者（candidatePage candidateGroups 角色取人，v1.6.0）
  setOrgProvider(orgProv: OrgUserProvider): this {
    this.orgProv = orgProv
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
      case 'processDesign/redeploy':
        return this.designRedeploy(args)
      case 'processDefine/redeploy':
        return this.redeploy(args)
      case 'processDefine/remove':
        return this.defineRemove(args)
      case 'processDefine/upAndDown':
        return this.defineUpAndDown(args)
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
      case 'processDesign/update':
        return this.designUpdate(args)
      case 'processDesign/updateDefine':
        return this.designUpdateDefine(args)
      case 'processDesign/remove':
        return this.designRemove(args)
      case 'processDesign/listByType':
        return this.designListByType(args)
      case 'processInstance/bizData':
        return this.bizData(args)
      case 'processSurrogate/page':
        return this.surrogatePage(args)
      case 'processSurrogate/save':
        return this.surrogateSave(args)
      case 'processSurrogate/update': // issues/77
        return this.surrogateUpdate(args)
      case 'processSurrogate/detail': // issues/77
        return this.surrogateDetail(args)
      case 'processSurrogate/remove':
        return this.surrogateRemove(args)
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
    // issues/56 E28：发起时抄送（f_ccActors）创建 cc 实例（对齐 Java enableCcActors 语义）
    const ccList = Array.isArray(flowArgs.f_ccActors) ? flowArgs.f_ccActors
      : typeof flowArgs.f_ccActors === 'string' && flowArgs.f_ccActors.trim()
        ? flowArgs.f_ccActors.split(',').map((x: string) => x.trim()).filter(Boolean) : []
    if (ccList.length > 0) {
      await this.repo.createCcInstance(inst.id, operator, ...ccList)
    }
    // startAndExecute：自动完成申请节点（assignee="applicant" → 发起人）
    const doing = await this.repo.findDoingTasks(inst.id)
    for (const task of doing) {
      await this.repo.addTaskActor(task.id, [operator])
      flowArgs.submitType = SUBMIT_APPLY
      // 对齐 boot3：f_nextNodeOperator（发起时预指派人）→ tf_nextNodeOperator（引擎执行参数）
      const startNextOp = flowArgs[KeyProcessStartNextNodeOperator]
      if (startNextOp != null && String(startNextOp) !== '') {
        flowArgs[KeyNextNodeOperator] = startNextOp
      }
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

  private async saveDeployedDefine(content: string, args: Record<string, any>): Promise<string> {
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
      id: '', name, displayName: flow.displayName ?? '', type: flow.type ?? 'approval',
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
    // findInstanceById 不加载 tasks（空），必须按实例查 doing 任务废弃
    const abandoned: ProcessTask[] = []
    for (const t of await this.repo.findDoingTasks(instanceId)) {
      t.abandon(now)
      abandoned.push(t)
    }
    // issues/53 E25：撤回状态应为 Withdraw(30) 而非 Reject(45)（对齐 Java）
    inst.withdraw(now)
    inst.updateUser = operator
    // 级联覆盖防护（issues/57 补正）：废弃副本同步回聚合——updateInstance 级联会用
    // 聚合内旧任务覆盖已废弃状态（memory 加载 tasks 时必现）
    inst.tasks = abandoned
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
    const pageNum = toInt(args.pageNum ?? 1)
    const pageSize = toInt(args.pageSize ?? 10)
    const [rows, total] = await this.ext().pageDesigns(pageNum, pageSize, undefined, parseMQuery(args))
    return pageData(pageNum, pageSize, total, rows.map(r => designRowToMap(r)))
  }

  /** 修改流程设计基本信息（对齐 boot3 ProcessDesignController.update，不写设计稿快照） */
  private async designUpdate(args: Record<string, any>): Promise<Record<string, any>> {
    const ext = this.ext()
    const design = await ext.findDesignById(toId(args.id))
    if (!design) throw new Error('流程设计不存在')
    if (args.name != null) design.name = String(args.name)
    if (args.displayName != null) design.displayName = String(args.displayName)
    if (args.type != null) design.type = String(args.type)
    if (args.icon != null) design.icon = String(args.icon)
    if (args.remark != null) design.remark = String(args.remark)
    design.updateUser = String(args.operator ?? 'system')
    await ext.updateDesign(design)
    return {}
  }

  /** 更新流程设计定义（设计稿保存，issues/08）：content 快照入库 + 同步基本信息 + 置未部署 */
  private async designUpdateDefine(args: Record<string, any>): Promise<Record<string, any>> {
    const ext = this.ext()
    const designId = toId(args.processDesignId)
    const design = await ext.findDesignById(designId)
    if (!design) throw new Error('流程设计不存在')
    // issues/31：兼容 boot3 顶层 JSON（无 content 字段）——非保留字段序列化为内容快照
    let content = args.content
    if (content == null) {
      const copy: Record<string, any> = {}
      for (const [k, v] of Object.entries(args)) {
        if (k !== 'processDesignId' && k !== 'operator') copy[k] = v
      }
      if (Object.keys(copy).length === 0) throw new Error('content 缺失')
      content = JSON.stringify(copy)
    }
    content = toStr(content)
    // 与最新一条相同则不重复入库（对齐 boot3 updateDefine）
    const hisList = await ext.listDesignHis(designId)
    if (hisList.length === 0 || toStr(hisList[0].content) !== content) {
      await ext.saveDesignHis({
        id: '', processDesignId: designId, content,
        createTime: new Date(), createUser: String(args.operator ?? 'system'),
      })
    }
    // 同步设计基本信息（jsonObject 里的 name/displayName/type）+ 内容变更 → 未部署
    try {
      const flow = JSON.parse(content)
      if (flow?.name) design.name = flow.name
      if (flow?.displayName) design.displayName = flow.displayName
      if (flow?.type) design.type = flow.type
    } catch { /* ignore */ }
    design.isDeployed = 0
    design.updateUser = String(args.operator ?? 'system')
    await ext.updateDesign(design)
    return {}
  }

  /** 删除设计稿（issues/28：兼容 {ids} 批量与单 {id}） */
  private async designRemove(args: Record<string, any>): Promise<Record<string, any>> {
    const ext = this.ext()
    for (const id of idListArgs(args)) await ext.removeDesign(id)
    return {}
  }

  /** 删除定义（issues/28：兼容 {ids} 批量与单 {id}） */
  private async defineRemove(args: Record<string, any>): Promise<Record<string, any>> {
    for (const id of idListArgs(args)) await this.repo.removeDefine(id)
    return {}
  }

  /** 启用/停用（issues/28：兼容 {ids, opType} 批量；opType/state 二选一） */
  private async defineUpAndDown(args: Record<string, any>): Promise<Record<string, any>> {
    const state = toInt(args.opType ?? args.state)
    for (const id of idListArgs(args)) await this.repo.updateDefineState(id, state)
    return {}
  }

  /** 按类型分组列出流程设计（issue 30，对齐 Java issues/28）：不依赖框架字典 */
  private async designListByType(args: Record<string, any>): Promise<Record<string, any>> {
    const ext = this.ext()
    const pageNum = args.pageNum != null ? toInt(args.pageNum) : 1
    const pageSize = args.pageSize != null ? toInt(args.pageSize) : 10000
    const [rows] = await ext.pageDesigns(pageNum, pageSize, [])
    // 每 name 最新 define（version 最大）
    const { rows: defRows } = await this.repo.pageDefines(1, 10000, [])
    const latestByName = new Map<string, any>()
    for (const r of defRows) {
      const prev = latestByName.get(r.name)
      if (!prev || r.version > prev.version) latestByName.set(r.name, r)
    }
    const groups: Record<string, any[]> = {}
    for (const d of rows) {
      const key = d.type || ''
      ;(groups[key] ??= []).push({
        processDesignId: d.id,
        name: d.name,
        displayName: d.displayName,
        icon: d.icon,
        remark: d.remark,
        processDefineId: latestByName.get(d.name)?.id ?? null,
        processDefineState: latestByName.get(d.name)?.state ?? null,
        jsonObject: this.parseGraph((await ext.listDesignHis(d.id))[0]?.content ?? ''),
      })
    }
    return groups
  }

  /** 按流程实例回显业务数据（issue 30，对齐 Java issues/28）：metaReader 注入式，未注入清晰报错 */
  private async bizData(args: Record<string, any>): Promise<Record<string, any>> {
    const instanceId = toId(args.processInstanceId ?? args.id)
    const inst = await this.repo.findInstanceById(instanceId)
    if (!inst) throw new Error('流程实例不存在')
    const def = await this.repo.findDefineById(inst.defineId)
    if (!def) throw new Error('流程定义不存在')
    const content = typeof def.content === 'string' ? def.content : new TextDecoder().decode(def.content as Uint8Array)
    let tableName: string | null = null
    try {
      const meta = JSON.parse(content)
      tableName = String(meta.relTableName ?? '').trim() || String(meta.name ?? '').trim() || null
    } catch { /* ignore */ }
    if (!tableName) throw new Error('流程定义未配置 relTableName')
    if (!this.metaReader) throw new Error('业务数据读取器未注册（facade.setMetaReader(MetaTableReader(...))，需引入 jeeflow.meta）')
    return this.metaReader.readByProcessInstance(tableName, instanceId) as Record<string, any>
  }

  /** 重新部署流程定义（issues/08）：替换最新定义内容 + 置已部署（对齐 boot3 redeploy） */
  private async designRedeploy(args: Record<string, any>): Promise<Record<string, any>> {
    const ext = this.ext()
    const designId = toId(args.id)
    const design = await ext.findDesignById(designId)
    if (!design) throw new Error('流程设计不存在')
    const hisList = await ext.listDesignHis(designId)
    if (hisList.length === 0) throw new Error('流程设计没有内容，无法发布')
    const content = toStr(hisList[0].content)
    let flow: any
    try {
      flow = JSON.parse(content)
    } catch (e) {
      throw new Error('流程定义 JSON 解析失败: ' + String(e))
    }
    if (!flow?.name) throw new Error('流程定义缺少 name')
    // 按 name 取最新定义：有则替换内容（version 不变），无则新建（对齐 boot3 redeploy）
    const last = await this.repo.findDefineByName(flow.name)
    let defineId: string
    if (!last) {
      defineId = await this.saveDeployedDefine(content, args)
    } else {
      last.name = flow.name
      last.displayName = flow.displayName ?? ''
      last.type = flow.type ?? ''
      last.content = content
      last.updateUser = String(args.operator ?? 'system')
      await this.repo.updateDefine(last)
      defineId = last.id
    }
    design.isDeployed = 1
    design.updateUser = String(args.operator ?? 'system')
    await ext.updateDesign(design)
    return { processDefineId: defineId }
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
    let jsonObject: Record<string, any> | undefined
    if (hisList.length > 0) {
      try {
        jsonObject = JSON.parse(toStr(hisList[0].content))
      } catch { /* ignore */ }
    }
    // issues/07：jsonObject 缺失基本信息时从设计表补齐（对齐 boot3 ProcessDesignServiceImpl.findById）
    if (!jsonObject || typeof jsonObject !== 'object') jsonObject = {}
    if (!(jsonObject.name)) jsonObject.name = design.name
    if (!(jsonObject.displayName)) jsonObject.displayName = design.displayName
    if (!(jsonObject.type)) jsonObject.type = design.type
    if (!(jsonObject.processDesignId)) jsonObject.processDesignId = design.id
    data.jsonObject = jsonObject
    data.his = hisList
    return data
  }

  private async designSave(args: Record<string, any>): Promise<Record<string, any>> {
    const ext = this.ext()
    const operator = String(args.operator ?? 'user1')
    const designId = args.id != null ? toId(args.id) : ''
    let design: ProcessDesign
    if (!designId) {
      design = {
        id: '', name: String(args.name ?? ''), displayName: String(args.displayName ?? ''),
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
      // 内容快照变更 → 置为未部署（对齐 boot3 updateDefine 语义，issues/08）
      if (args.content != null) found.isDeployed = 0
      await ext.updateDesign(found)
      design = found
    }
    // 内容快照（设计稿内容存历史表）——issues/51 E23：无 content 也写默认快照
    // （对齐 Java contentBytes 默认 JSON），保证「新建 → 部署」链路可用
    if (args.content != null) {
      await ext.saveDesignHis({
        id: '', processDesignId: design.id, content: String(args.content),
        createTime: new Date(), createUser: operator,
      })
    } else {
      await ext.saveDesignHis({
        id: '', processDesignId: design.id,
        content: JSON.stringify({
          name: design.name, displayName: design.displayName, type: design.type,
          nodes: [], edges: [],
        }),
        createTime: new Date(), createUser: operator,
      })
    }
    return { id: design.id }
  }

  // ── 委托代理（需扩展仓储） ───────────────────────────────────────────────

  private async surrogatePage(args: Record<string, any>): Promise<Record<string, any>> {
    const filters = args.operator != null ? { operator: String(args.operator) } : undefined
    const pageNum = toInt(args.pageNum ?? 1)
    const pageSize = toInt(args.pageSize ?? 10)
    const [rows, total] = await this.ext().pageSurrogates(
      pageNum, pageSize, filters, parseMQuery(args))
    // issues/77：行走 surrogateRowToMap（时间格式化），与 detail 同构
    return pageData(pageNum, pageSize, total, rows.map(r => surrogateRowToMap(r)))
  }

  private async surrogateSave(args: Record<string, any>): Promise<Record<string, any>> {
    const ext = this.ext()
    const operator = String(args.operator ?? 'user1')
    const surrogateId = args.id != null ? toId(args.id) : ''
    let surrogate: ProcessSurrogate
    if (!surrogateId) {
      surrogate = {
        id: '', operator, surrogate: '', processName: '', // 授权人 = 操作人（新建必有）
        enabled: 1,
        createTime: new Date(), createUser: operator,
        updateTime: new Date(), updateUser: operator,
      }
      this.applySurrogateFields(surrogate, args, operator)
      await ext.saveSurrogate(surrogate)
    } else {
      const found = await ext.findSurrogateById(surrogateId)
      if (!found) throw new Error('委托记录不存在')
      this.applySurrogateFields(found, args, operator)
      await ext.updateSurrogate(found)
      surrogate = found
    }
    return { id: surrogate.id }
  }

  /** 委托更新（issues/77）：按 id 全字段更新，id 缺失/不存在报错 */
  private async surrogateUpdate(args: Record<string, any>): Promise<Record<string, any>> {
    const ext = this.ext()
    const surrogateId = toId(args.id)
    const surrogate = await ext.findSurrogateById(surrogateId)
    if (!surrogate) throw new Error('委托记录不存在')
    const operator = String(args.operator ?? 'user1')
    this.applySurrogateFields(surrogate, args, operator)
    await ext.updateSurrogate(surrogate)
    return { id: surrogate.id }
  }

  /** 委托详情（issues/77）：按 id 查单条，返回行结构（时间格式化） */
  private async surrogateDetail(args: Record<string, any>): Promise<Record<string, any>> {
    const surrogateId = toId(args.id)
    const surrogate = await this.ext().findSurrogateById(surrogateId)
    if (!surrogate) throw new Error('委托记录不存在')
    return surrogateRowToMap(surrogate)
  }

  /** 删除委托（issues/95：前端「我的委托」行内/批量删除统一发 {ids}，与 define/design remove 同惯例） */
  private async surrogateRemove(args: Record<string, any>): Promise<Record<string, any>> {
    const ext = this.ext()
    for (const id of idListArgs(args)) await ext.removeSurrogate(id)
    return {}
  }

  /** 委托写入公共字段。授权人（operator）仅在显式传入时覆盖，避免 update
   *  时清空原授权人（前端编辑表单不带 operator；集成层注入时 operator=授权人，覆盖无害） */
  private applySurrogateFields(s: ProcessSurrogate, args: Record<string, any>, operator: string): void {
    s.processName = String(args.processName ?? '')
    if ('operator' in args) s.operator = String(args.operator)
    s.surrogate = String(args.surrogate ?? '')
    s.startTime = parseSurrogateTime(args.startTime)
    s.endTime = parseSurrogateTime(args.endTime)
    s.enabled = args.enabled != null ? toInt(args.enabled) : 1
    s.updateUser = operator
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
    let nodeProgress: Record<string, any> = {}
    if (def) {
      try {
        const flow = JSON.parse(toStr(def.content))
        nodeProgress = await this.buildNodeProgress(flow, his)
        await this.collectPath(flow, 'start', '', active, history, edges, new Set(), inst.variables ?? {}, his)
      } catch { /* ignore */ }
    }
    return { activeNodeNames: active, historyNodeNames: history, historyEdgeNames: edges, nodeProgress }
  }

  /** 节点成员进度（issue 41，对齐 boot3 highLight）：按任务状态 + 会签变量组装
   *  nodeProgress——会签节点带 type（PARALLEL/SEQUENTIAL），成员 done/active 标记；
   *  动态参与人节点（无静态 actorIds）不返回；name 走引擎 UserProvider SPI 解析
   *  realName（未注入/查不到时缺省空串，前端降级显示 id） */
  private async buildNodeProgress(flow: Record<string, any>, his: ProcessTask[]): Promise<Record<string, any>> {
    const progress: Record<string, any> = {}
    const names = [...new Set(his.map(t => t.taskName))]
    for (const name of names) {
      const tasks = his.filter(t => t.taskName === name)
      const vars: Record<string, any> = tasks[0]?.variables ?? {}
      // 完整办理人列表：会签变量 operatorList_{node} 优先（顺序会签全量），否则任务 actorIds 并集
      let members = Array.isArray(vars[`operatorList_${name}`]) ? vars[`operatorList_${name}`] : null
      if (!members || members.length === 0) {
        members = [...new Set(tasks.flatMap(t => t.actorIds ?? []))]
      }
      if (!members || members.length === 0) continue // 动态参与人：无静态成员，不返回
      const doneSet = new Set<string>()
      for (const t of tasks) {
        if (t.taskState === TaskState.Done) for (const a of t.actorIds ?? []) doneSet.add(a)
      }
      const activeActor = tasks.find(t => t.taskState === TaskState.Doing)?.actorIds?.[0]
      const node = (flow.nodes ?? []).find((n: any) => n.id === name)
      // 会签判定：定义节点属性（引擎创建任务时 performType 未落任务表，取模型为准）
      const nodeProps = node?.properties ?? {}
      const isCs = isCountersign(nodeProps.performType) || nodeProps.countersignType != null
      // 姓名走 UserProvider SPI 解析（未注入/查不到缺省空串），done/active 按任务状态标记
      const memberList = await this.resolveMemberNames(members)
      for (const m of memberList) {
        if (doneSet.has(m.id)) m.done = true
        else if (m.id === activeActor) m.active = true
      }
      const item: Record<string, any> = { members: memberList }
      if (isCs && nodeProps.countersignType) {
        item.type = nodeProps.countersignType
      }
      progress[name] = item
    }
    return progress
  }

  /** 成员姓名解析（issue 43/E15）：UserProvider SPI 并行批量解析 realName，查不到缺省空串 */
  private async resolveMemberNames(ids: string[]): Promise<Record<string, any>[]> {
    const userProv = this.engine.getUserProvider()
    const nameMap: Record<string, string> = {}
    if (userProv) {
      const results = await Promise.all(ids.map(async id => {
        try {
          const u = await userProv.getUser(id)
          return [id, u?.realName ?? ''] as const
        } catch {
          return [id, ''] as const // 单用户失败不影响其余
        }
      }))
      for (const [id, name] of results) if (name) nameMap[id] = name
    }
    return ids.map(id => ({ id, name: nameMap[id] ?? '' }))
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
      finishTime: fmtTime(t.finishTime), variable: t.variables ?? {},
      ext: t.variables ?? {}, // issues/15：前端读 ext.tf_approvalComment
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
    const { rows, total } = await this.repo.pageCcInstances(pageNum, pageSize, actorId, parseMQuery(args))
    return pageData(pageNum, pageSize, total, rows.map(r => ccRowToMap(r)))
  }

  private async taskDetail(args: Record<string, any>): Promise<any> {
    const taskId = toId(args.id)
    const operator = String(args.operator ?? 'user1')
    const task = await this.repo.findTaskById(taskId)
    if (!task) throw new Error('任务不存在')
    const actors = await this.repo.findTaskActors(taskId)
    // issues/82-5：任务级 ext.isFirstTaskNode（前端 detail.vue 双兜底 record.ext?.isFirstTaskNode）
    // 首个任务节点且 DOING → true，与 instance detail 的 activeTaskList 行语义一致
    const tExt: Record<string, any> = { ...(task.variables ?? {}) }
    const doing = task.taskState === TaskState.Doing
    tExt.isFirstTaskNode = false
    const vo: Record<string, any> = {
      id: task.id, processInstanceId: task.processInstanceId, taskName: task.taskName,
      displayName: task.displayName, taskType: task.taskType ?? null,
      performType: task.performType ?? null, taskState: task.taskState,
      operator: task.actorId ?? '', formKey: task.formKey ?? '',
      taskActorIdList: actors, executable: task.isAllowed(operator),
      ext: tExt,
      taskFormData: formDataOf(task.variables, 'tf_'), // issues/15
    }
    // taskModel：流程定义中对应节点
    const inst = await this.repo.findInstanceById(task.processInstanceId)
    if (inst) {
      const def = await this.repo.findDefineById(inst.defineId)
      if (def) {
        vo.jsonObject = this.parseGraph(def.content) // issues/05
        tExt.isFirstTaskNode = doing && task.taskName === this.firstTaskNodeId(vo.jsonObject)
        try {
          const flow = JSON.parse(toStr(def.content))
          for (const n of flow.nodes ?? []) {
            if (n.id === task.taskName) {
              // issues/62：taskModel 补 form/ext（节点字段权限，对齐 boot2）
              vo.taskModel = {
                name: n.id, displayName: n.text?.value ?? '', type: n.type,
                form: n.properties?.form ?? null,
                ext: n.properties?.field ?? null,
              }
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
    const pageNum = toInt(args.pageNum ?? 1)
    const pageSize = toInt(args.pageSize ?? 10)
    const taskId = toId(args.processTaskId ?? args.id)
    const task = await this.repo.findTaskById(taskId)
    if (!task) throw new Error('任务不存在')
    const inst = await this.repo.findInstanceById(task.processInstanceId)
    if (!inst) throw new Error('流程实例不存在')
    // 模型候选解析：后继任务节点的 candidateUsers / candidateGroups 配置
    let candidates: string[] = []
    const def = await this.repo.findDefineById(inst.defineId)
    if (def) {
      try {
        const flow = JSON.parse(toStr(def.content))
        candidates = await this.nextTaskCandidates(flow, task.taskName)
      } catch { /* ignore */ }
    }
    if (candidates.length > 0) {
      // issues/80：行键对齐前端 UserSelect（valueField='id'）——补 id 键，保留 userId 兼容旧消费方
      const rows = candidates.map(c => ({ id: c, userId: c, realName: c }))
      return pageData(pageNum, pageSize, rows.length, rows)
    }
    // 无模型候选 → 用户分页搜索（依赖 userSearch 钩子）
    if (!this.userSearch) throw new Error('未配置 userSearch（用户搜索钩子）')
    const [rows, total] = await this.userSearch(args)
    return pageData(pageNum, pageSize, total, rows)
  }

  private async nextTaskCandidates(flow: any, taskName: string): Promise<string[]> {
    const result: string[] = []
    const visited = new Set<string>()
    const collect = async (node: any) => {
      const v = node.properties?.candidateUsers
      if (v) {
        for (const s of String(v).split(',')) {
          const t = s.trim()
          if (t && !result.includes(t)) result.push(t)
        }
      }
      // candidateGroups：按角色取人（v1.6.0，对齐 boot4 GlobalCandidateHandler）
      const g = node.properties?.candidateGroups
      if (g && this.orgProv) {
        for (const rc of String(g).split(',')) {
          const role = rc.trim()
          if (!role) continue
          const ids = await this.orgProv.findByRole(role)
          for (const uid of ids ?? []) {
            if (uid && !result.includes(uid)) result.push(uid)
          }
        }
      }
    }
    const walk = async (nodeId: string) => {
      if (visited.has(nodeId)) return
      visited.add(nodeId)
      for (const e of flow.edges ?? []) {
        if (e.sourceNodeId !== nodeId) continue
        const target = (flow.nodes ?? []).find((n: any) => n.id === e.targetNodeId)
        if (!target) continue
        if (target.type === 'snaker:task' || target.type === 'snaker:custom') {
          await collect(target)
          continue
        }
        if (['snaker:fork', 'snaker:join', 'snaker:decision'].includes(target.type)) {
          await walk(target.id)
        }
      }
    }
    await walk(taskName)
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
    const { rows, total } = await this.repo.pageDefines(pageNum, pageSize, parseMQuery(args))
    return pageData(pageNum, pageSize, total, rows.map(r => defineRowToMap(r)))
  }

  private async defineDetail(args: Record<string, any>): Promise<Record<string, any>> {
    const id = toId(args.id)
    const def = await this.repo.findDefineById(id)
    if (!def) throw new Error('流程定义不存在')
    return {
      id: def.id, name: def.name, displayName: def.displayName,
      type: def.type, state: def.state, version: def.version,
      jsonObject: this.parseGraph(def.content), // issues/05
    }
  }

  private async instancePage(args: Record<string, any>): Promise<Record<string, any>> {
    const pageNum = toInt(args.pageNum ?? 1)
    const pageSize = toInt(args.pageSize ?? 10)
    const operator = String(args.operator ?? 'user1')
    const { rows, total } = await this.repo.pageInstances(pageNum, pageSize, operator, parseMQuery(args))
    return pageData(pageNum, pageSize, total, rows.map(r => instanceRowToMap(r)))
  }

  private async instanceDetail(args: Record<string, any>): Promise<Record<string, any>> {
    const id = toId(args.id)
    const inst = await this.repo.findInstanceById(id)
    if (!inst) throw new Error('流程实例不存在')
    const def0 = await this.repo.findDefineById(inst.defineId)
    const graph = def0 ? this.parseGraph(def0.content) : undefined
    // 任务列表（issues/05-4）：全量 tasks + activeTaskList（仅 DOING）+ 任务行 ext/isFirstTaskNode
    const firstTaskNodeId = this.firstTaskNodeId(graph)
    const tasks: Record<string, any>[] = []
    const activeTaskList: Record<string, any>[] = []
    for (const t of inst.tasks ?? []) {
      const vo: Record<string, any> = {
        id: t.id, processInstanceId: t.processInstanceId, taskName: t.taskName,
        displayName: t.displayName, taskType: t.taskType ?? null,
        performType: t.performType ?? null, taskState: t.taskState,
        operator: t.actorId ?? '', finishTime: t.finishTime,
        expireTime: t.expireTime, formKey: t.formKey ?? '', taskParentId: t.parentTaskId ?? null,
        variable: JSON.stringify(t.variables ?? {}),
        createTime: t.createTime, createUser: t.createUser,
        updateTime: t.updateTime, updateUser: t.updateUser,
        taskActorIdList: t.actorIds ?? [],
        taskFormData: formDataOf(t.variables, 'tf_'), // issues/15
      }
      const ext: Record<string, any> = { ...(t.variables ?? {}) }
      const doing = t.taskState === TaskState.Doing
      ext.isFirstTaskNode = doing && t.taskName === firstTaskNodeId
      vo.ext = ext
      tasks.push(vo)
      if (doing) activeTaskList.push(vo)
    }
    const data: Record<string, any> = {
      id: inst.id, parentId: inst.parentId, processDefineId: inst.defineId,
      state: inst.state, parentNodeName: inst.parentNodeName,
      businessNo: inst.businessNo, operator: inst.operator,
      variables: inst.variables,
      formData: formDataOf(inst.variables, 'f_'), // issues/15
      createTime: inst.createTime, createUser: inst.createUser,
      jsonObject: graph, // issues/05
      tasks,
      activeTaskList,
    }
    if (def0) {
      data.displayName = def0.displayName // issues/15
      data.name = def0.name
      data.version = def0.version
    }
    return data
  }

  /** 流程 JSON 中第一个任务节点 id（issues/05-4 isFirstTaskNode 用） */
  private firstTaskNodeId(graph: Record<string, any> | undefined): string {
    for (const n of graph?.nodes ?? []) {
      if (n?.type === 'snaker:task') return n.id
    }
    return ''
  }

  private async todoList(args: Record<string, any>): Promise<Record<string, any>> {
    const pageNum = toInt(args.pageNum ?? 1)
    const pageSize = toInt(args.pageSize ?? 10)
    const actorId = String(args.operator ?? 'user1')
    const { rows, total } = await this.repo.pageTodoTasks(pageNum, pageSize, actorId, parseMQuery(args))
    return pageData(pageNum, pageSize, total, rows.map(r => taskRowToMap(r)))
  }

  private async doneList(args: Record<string, any>): Promise<Record<string, any>> {
    const pageNum = toInt(args.pageNum ?? 1)
    const pageSize = toInt(args.pageSize ?? 10)
    const operator = String(args.operator ?? 'user1')
    const { rows, total } = await this.repo.pageDoneTasks(pageNum, pageSize, operator, parseMQuery(args))
    return pageData(pageNum, pageSize, total, rows.map(r => taskRowToMap(r)))
  }

  /** 定义 content 解析为 LogicFlow JSON（issues/05 jsonObject） */
  private parseGraph(content: string | Uint8Array): Record<string, any> | undefined {
    try {
      const str = typeof content === 'string' ? content : new TextDecoder().decode(content)
      const obj = JSON.parse(str)
      return obj && typeof obj === 'object' ? obj : undefined
    } catch {
      return undefined
    }
  }

}

// ── 行转 Map（issues/05-2 列表字段契约 + 05-3 时间格式）─────────────────────

/** issues/15：取 vars 中 prefix 前缀字段，输出「带前缀 + 去前缀副本」（对齐 boot3 getFormData） */
function formDataOf(vars: Record<string, any> | undefined, prefix: string): Record<string, any> {
  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(vars ?? {})) {
    if (k.startsWith(prefix)) {
      out[k] = v
      out[k.slice(prefix.length)] = v
    }
  }
  return out
}

/** Date → 'yyyy-MM-dd HH:mm:ss'（null/undefined → null） */
function fmtTime(v: Date | undefined | null): string | null {
  if (v == null) return null
  const p = (n: number) => String(n).padStart(2, '0')
  return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())} ${p(v.getHours())}:${p(v.getMinutes())}:${p(v.getSeconds())}`
}

/** JSON 字符串 → 对象（坏 JSON / 空返回空对象） */
function parseVarMap(json: string): Record<string, any> {
  if (!json) return {}
  try {
    const o = JSON.parse(json)
    return o && typeof o === 'object' ? o : {}
  } catch {
    return {}
  }
}

/** 定义行：时间格式化 */
function defineRowToMap(r: DefineRow): Record<string, any> {
  return {
    id: r.id, name: r.name, displayName: r.displayName, type: r.type,
    state: r.state, version: r.version,
    createTime: fmtTime(r.createTime), createUser: r.createUser,
    updateTime: fmtTime(r.updateTime), updateUser: r.updateUser,
  }
}

/** 设计行：时间格式化（issues/63） */
/** 委托行：时间格式化（issues/77，对齐 Java surrogateRowToMap / Go surrogateRowToMap / SPEC） */
function surrogateRowToMap(s: ProcessSurrogate): Record<string, any> {
  return {
    id: s.id, processName: s.processName, operator: s.operator, surrogate: s.surrogate,
    startTime: fmtTime(s.startTime ?? null), endTime: fmtTime(s.endTime ?? null),
    enabled: s.enabled,
    createTime: fmtTime(s.createTime ?? null), createUser: s.createUser,
    updateTime: fmtTime(s.updateTime ?? null), updateUser: s.updateUser,
  }
}

/** 解析委托时间入参：兼容 yyyy-MM-dd HH:mm:ss（前端 RangePicker/SPEC 契约）与 ISO T（issues/77） */
function parseSurrogateTime(v: any): Date | undefined {
  if (v == null) return undefined
  const s = String(v).trim()
  if (!s) return undefined
  for (const fmt of ['YYYY-MM-DD HH:mm:ss', 'YYYY-MM-DDTHH:mm:ss', 'YYYY-MM-DD']) {
    const m = s.match(fmt === 'YYYY-MM-DD'
      ? /^(\d{4})-(\d{2})-(\d{2})$/
      : /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})$/)
    if (!m) continue
    if (fmt === 'YYYY-MM-DD') return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]))
  }
  // 兜底：交给 Date 解析（覆盖其它可解析形态），失败返回 undefined
  const d = new Date(s)
  return isNaN(d.getTime()) ? undefined : d
}

function designRowToMap(r: ProcessDesign): Record<string, any> {
  return {
    id: r.id, name: r.name, displayName: r.displayName,
    type: r.type, icon: r.icon, isDeployed: r.isDeployed, remark: r.remark,
    createTime: fmtTime(r.createTime), createUser: r.createUser,
    updateTime: fmtTime(r.updateTime), updateUser: r.updateUser,
  }
}

/** 实例行：ext（实例变量对象）+ displayName/version（定义） */
function instanceRowToMap(r: InstanceRow): Record<string, any> {
  return {
    id: r.id, parentId: r.parentId ?? null, processDefineId: r.defineId,
    state: r.state, parentNodeName: r.parentNodeName, businessNo: r.businessNo,
    operator: r.operator, expireTime: fmtTime(r.expireTime),
    variable: r.variables, createTime: fmtTime(r.createTime), createUser: r.createUser,
    updateTime: fmtTime(r.updateTime), updateUser: r.updateUser,
    processDefineName: r.defineName, processDefineDisplayName: r.defineDisplayName,
    processDefineVersion: r.defineVersion,
    ext: r.variables, displayName: r.defineDisplayName, version: r.defineVersion,
  }
}

/** 抄送行：ext（实例变量对象）+ displayName/version（定义） */
function ccRowToMap(r: CcInstanceRow): Record<string, any> {
  return {
    id: r.id, parentId: r.parentId ?? null, processDefineId: r.defineId,
    state: r.state, parentNodeName: r.parentNodeName, businessNo: r.businessNo,
    operator: r.operator, expireTime: fmtTime(r.expireTime),
    variable: r.variables, createTime: fmtTime(r.createTime), createUser: r.createUser,
    updateTime: fmtTime(r.updateTime), updateUser: r.updateUser,
    processDefineName: r.defineName, processDefineDisplayName: r.defineDisplayName,
    processDefineVersion: r.defineVersion,
    ext: r.variables, displayName: r.defineDisplayName, version: r.defineVersion,
  }
}

/** 任务行：ext（任务变量，空回退实例变量）+ instanceExt + version */
function taskRowToMap(r: TaskRow): Record<string, any> {
  const instanceExt = parseVarMap(r.instanceVariable)
  const ext = Object.keys(r.variables ?? {}).length > 0 ? r.variables : instanceExt
  return {
    id: r.id, processInstanceId: r.processInstanceId, taskName: r.taskName,
    displayName: r.displayName, taskType: r.taskType, performType: r.performType,
    taskState: r.taskState, operator: r.operator, finishTime: fmtTime(r.finishTime),
    expireTime: fmtTime(r.expireTime), formKey: r.formKey, taskParentId: r.taskParentId ?? null,
    variable: r.variables, createTime: fmtTime(r.createTime), createUser: r.createUser,
    updateTime: fmtTime(r.updateTime), updateUser: r.updateUser,
    processDefineName: r.processDefineName, processDefineDisplayName: r.processDefineDisplayName,
    instanceVariable: r.instanceVariable, instanceCreateTime: fmtTime(r.instanceCreateTime),
    ext, instanceExt, version: r.defineVersion,
    taskFormData: formDataOf(r.variables, 'tf_'), // issues/15
  }
}

// ── 工具 ──────────────────────────────────────────────────────────────────────

/** m_ 前缀查询参数解析（issues/05-5，对齐 Java JeeflowQueryParser）：
 *  m_EQ_taskName → t.task_name EQ；m_pd_LIKE_displayName → pd.display_name LIKE */
function parseMQuery(args: Record<string, any>): QueryCondition[] {
  const out: QueryCondition[] = []
  for (const [key, value] of Object.entries(args)) {
    if (!key.startsWith('m_') || value == null || value === '') continue
    const parts = key.slice(2).split('_')
    if (parts.length < 2) continue
    let column: string
    let operator: string
    if (parts.length === 2) {
      // 无别名 → 默认主表别名 t（对齐 Java，白名单列均带表别名）
      operator = parts[0]
      column = 't.' + toUnderscore(parts[1])
    } else {
      operator = parts[1]
      column = parts[0] + '.' + toUnderscore(parts[2])
    }
    out.push({ column, operator: operator.toUpperCase(), value })
  }
  return out
}

function toUnderscore(camel: string): string {
  return camel.replace(/[A-Z]/g, c => '_' + c.toLowerCase())
}

function toStr(v: any): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (v instanceof Uint8Array || Buffer.isBuffer(v)) return Buffer.from(v).toString('utf8')
  // 对象/数组（content 等字段前端直接传 JSON 对象）：序列化为 JSON 字符串
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

function toId(v: any): string {
  // issue 38 E9：id 全程 string 承载——Java 雪花 id（>2^53）经 Number() 必丢精度。
  // 数字输入（JS 安全整数内）转字符串；字符串输入原样保留（含超长雪花 id）。
  if (v == null) throw new Error('id 缺失或非法')
  // issues/82 负向（对齐 Go TestSnowflakeIDPrecision / issues/38 E9）：数字 id 超 2^53
  // 说明它已被 JSON 解析器（JSON.parse / encoding/json）降级为 float64 且精度已丢，
  // 必须显性报错而非 String() 静默截断成错误 id。
  if (typeof v === 'number' && Math.abs(v) > 2 ** 53) {
    throw new Error(`id ${v} 超出 float64 精确范围（2^53），请以字符串传递`)
  }
  const s = String(v).trim()
  if (!/^\d+$/.test(s) || s === '0') throw new Error('id 缺失或非法')
  return s
}

/** 删除/启停类 action 的批量主键：mldong IdsParam 惯例下 {ids} 数组优先，兼容单 {id}；
 *  两者皆缺失、空数组或含非法值一律报错（issues/95，对齐 Java idListArgs） */
function idListArgs(args: Record<string, any>): string[] {
  if (Array.isArray(args.ids)) {
    if (args.ids.length === 0) throw new Error('id 缺失或非法')
    return args.ids.map(toId)
  }
  return [toId(args.id)]
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

/** issues/64：对齐 mldong 分页五键（Java pageResult / Go pageData） */
function pageData(pageNum: number, pageSize: number, total: number, rows: any): Record<string, any> {
  const pn = pageNum || 1
  const ps = pageSize || 10
  let totalPage = 0
  if (total > 0 && ps > 0) totalPage = Math.ceil(total / ps)
  return { pageNum: pn, pageSize: ps, recordCount: total, totalPage, rows }
}
