// jeeflow-node Express demo —— boot2 接口规范对齐
import express from 'express'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EngineImpl } from '../src/engine.js'
import { JeeflowFacade as Facade } from '../src/facade.js'
import { MemoryRepository } from '../src/memory.js'
import { TaskState, type ProcessDefine } from '../src/model.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const repo = new MemoryRepository()
const engine = new EngineImpl(repo, undefined, undefined, {
  async eval(expr: string, vars: Record<string, any>) {
    const amt = Number(vars?.amount)
    if (isNaN(amt)) return false
    if (expr === 'amount > 1000') return amt > 1000
    if (expr === 'amount >= 1000') return amt >= 1000
    if (expr === 'amount < 1000') return amt < 1000
    if (expr === 'amount <= 1000') return amt <= 1000
    if (expr === 'amount == 1000') return amt === 1000
    if (expr === 'amount != 1000') return amt !== 1000
    return false
  }
})
const facade = new Facade(engine, repo, undefined)

// ─── 从共享 JSON 文件加载所有流程 ────────────────────────────────────────────────
let flowsDir = join(__dirname, '..', '..', 'jeeflow-java', 'jeeflow-core', 'src', 'test', 'resources', 'flows')
try {
  const files = readdirSync(flowsDir).filter(f => f.endsWith('.json')).sort()
  files.forEach((fname, i) => {
    const content = readFileSync(join(flowsDir, fname), 'utf-8')
    const raw = JSON.parse(content)
    const def: ProcessDefine = {
      id: i + 1,
      name: raw.name || fname,
      displayName: raw.displayName || fname,
      type: raw.type || 'approval',
      state: 1, version: 1,
      content,
      createTime: new Date(), updateTime: new Date(),
      createUser: '', updateUser: '',
    }
    repo.addDefine(def)
    console.log(`  loaded: ${def.id} ${def.displayName}`)
  })
} catch(e) {
  console.error('Flow load error:', e)
}

const app = express()
app.use(express.json())

// CORS——允许 jeeflow-ui (localhost:5173) 跨域访问
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS, PUT, DELETE')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (_req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

// ─── Helpers（boot2 CommonResult：code=0 成功 / 99999999 失败，字段 code/msg/data）──
const ok = (data: any = null) => ({ code: 0, msg: '成功', data })
const err = (msg: string, code = 99999999) => ({ code, msg })
const page = (rows: any[], pageNum = 1, pageSize = 999) =>
  ({ pageNum, pageSize, rows, recordCount: rows.length, totalPage: 1 })
const fmtTime = (t?: Date) => (t ? t.toISOString().replace('T', ' ').slice(0, 19) : null)
const parseContent = (def: ProcessDefine | null) =>
  def ? JSON.parse(typeof def.content === 'string' ? def.content : new TextDecoder().decode(def.content as Uint8Array)) : null

// boot2 submitType 枚举
const APPLY = 0, AGREE = 1, REJECT = 2, ROLLBACK = 3, JUMP = 4, RE_APPLY = 5
const ROLLBACK_TO_OPERATOR = 6, COUNTERSIGN_DISAGREE = 20

const instVo = (inst: any, def: ProcessDefine | null = null): any => {
  const vo: any = {
    id: inst.id, parentId: inst.parentId ?? null, processDefineId: inst.defineId,
    state: inst.state, parentNodeName: inst.parentNodeName ?? '',
    businessNo: inst.businessNo ?? '', operator: inst.operator,
    expireTime: fmtTime(inst.expireTime), variable: JSON.stringify(inst.variables ?? {}),
    createTime: fmtTime(inst.createTime), createUser: inst.createUser,
    updateTime: fmtTime(inst.updateTime), updateUser: inst.updateUser,
  }
  if (def) {
    vo.displayName = def.displayName
    vo.name = def.name
    vo.version = def.version
    vo.jsonObject = parseContent(def)
  }
  vo.activeTaskList = (inst.tasks ?? []).filter((t: any) => t.taskState === TaskState.Doing).map((t: any) => taskVo(t))
  return vo
}

const taskVo = (t: any, inst: any = null, def: ProcessDefine | null = null): any => {
  const vo: any = {
    id: t.id, processInstanceId: t.processInstanceId,
    taskName: t.taskName, displayName: t.displayName,
    taskType: t.taskType ?? 0, performType: t.performType ?? 0,
    taskState: t.taskState, operator: t.actorId ?? '',
    finishTime: fmtTime(t.finishTime), expireTime: fmtTime(t.expireTime),
    formKey: t.formKey ?? '', taskParentId: t.parentTaskId ?? null,
    variable: JSON.stringify(t.variables ?? {}),
    createTime: fmtTime(t.createTime), createUser: t.createUser,
    updateTime: fmtTime(t.updateTime), updateUser: t.updateUser,
  }
  if (inst && def) {
    vo.processDefineName = def.name
    vo.processDefineDisplayName = def.displayName
    vo.instanceCreateTime = fmtTime(inst.createTime)
  }
  vo.taskActorIdList = t.actorIds ?? []
  return vo
}

// ─── 仪表盘统计（UI 用，非 boot2 端点）───────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  const userId = String(req.query.userId ?? 'user1')
  let todoCount = 0
  for (const t of repo.allTasks()) {
    if (t.taskState !== TaskState.Doing) continue
    const actors = await repo.findTaskActors(t.id)
    if (t.actorIds.includes(userId) || actors.includes(userId)) todoCount++
  }
  let myInstanceCount = 0
  for (const i of repo.allInstances()) if (i.createUser === userId) myInstanceCount++
  res.json(ok({ todoCount, myInstanceCount }))
})

// ─── 统一门面转发（v1.5.0）：/wf/{action}，action 多段（如 processDefine/page）──────────────
app.post('/wf/*', async (req, res) => {
  try {
    const action = String(req.params[0] ?? '').replace(/^\//, '')
    const body = req.body ?? {}
    res.json(await facade.flow(action, body))
  } catch (e: any) {
    res.json({ code: 99999999, msg: e.message })
  }
})

// ─── 仪表盘统计（UI 用，非 boot2 端点）───────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  const userId = String(req.query.userId ?? 'user1')
  let todoCount = 0
  for (const t of repo.allTasks()) {
    if (t.taskState !== TaskState.Doing) continue
    const actors = await repo.findTaskActors(t.id)
    if (t.actorIds.includes(userId) || actors.includes(userId)) todoCount++
  }
  let myInstanceCount = 0
  for (const i of repo.allInstances()) if (i.createUser === userId) myInstanceCount++
  res.json(ok({ todoCount, myInstanceCount }))
})

// ─── 流程定义 ────────────────────────────────────────────────────────────────────

app.post('/wf/processDefine/page', (_req, res) => {
  const rows = repo.allDefines().map(d => ({
    id: d.id, name: d.name, displayName: d.displayName, type: d.type,
    state: d.state, version: d.version,
    createTime: fmtTime(d.createTime), updateTime: fmtTime(d.updateTime),
  }))
  res.json(ok(page(rows)))
})

app.post('/wf/processDefine/detail', (req, res) => {
  const def = repo.allDefines().find(d => d.id === Number(req.body?.id))
  if (!def) return res.json(err('流程定义不存在'))
  res.json(ok({ id: def.id, name: def.name, displayName: def.displayName, type: def.type,
    state: def.state, version: def.version, jsonObject: parseContent(def) }))
})

app.post('/wf/processDefine/startAndExecute', startFlow)
app.post('/wf/processInstance/startAndExecute', startFlow)

async function startFlow(req: any, res: any) {
  try {
    const { processDefineId, operator = 'user1', ...rest } = req.body ?? {}
    const args: Record<string, any> = { ...rest }
    const inst = await engine.startProcessInstanceById(Number(processDefineId), operator, args)
    // boot2 startAndExecute：自动完成申请节点
    const doing = await repo.findDoingTasks(inst.id)
    for (const task of doing) {
      await repo.addTaskActor(task.id, [operator])
      await engine.executeProcessTask(task.id, operator, { ...args, submitType: APPLY })
    }
    res.json(ok())
  } catch (e: any) { res.json(err(e.message)) }
}

// ─── 流程实例 ────────────────────────────────────────────────────────────────────

app.post('/wf/processInstance/page', async (req, res) => {
  const userId = String(req.body?.operator ?? 'user1')
  const rows: any[] = []
  for (const i of repo.allInstances()) {
    if (i.createUser !== userId) continue
    const def = await repo.findDefineById(i.defineId)
    const inst = await repo.findInstanceById(i.id)
    rows.push(instVo(inst, def))
  }
  rows.sort((a, b) => b.id - a.id)
  res.json(ok(page(rows)))
})

app.post('/wf/processInstance/detail', async (req, res) => {
  const inst = await repo.findInstanceById(Number(req.body?.id))
  if (!inst) return res.json(err('实例不存在'))
  const def = await repo.findDefineById(inst.defineId)
  res.json(ok(instVo(inst, def)))
})

app.post('/wf/processInstance/highLight', async (req, res) => {
  const inst = await repo.findInstanceById(Number(req.body?.id))
  if (!inst) return res.json(err('实例不存在'))
  const finished = new Set<string>()
  const active = new Set<string>()
  for (const t of inst.tasks) {
    if (t.taskState === TaskState.Done) finished.add(t.taskName)
    if (t.taskState === TaskState.Doing) active.add(t.taskName)
  }
  const finishedEdges: string[] = []
  const def = await repo.findDefineById(inst.defineId)
  const graph = parseContent(def)
  if (graph) {
    for (const e of graph.edges ?? []) {
      if (finished.has(e.sourceNodeId) && finished.has(e.targetNodeId)) finishedEdges.push(e.id)
    }
  }
  res.json(ok({ historyNodeNames: [...finished], historyEdgeNames: finishedEdges, activeNodeNames: [...active] }))
})

app.post('/wf/processInstance/approvalRecord', async (req, res) => {
  const inst = await repo.findInstanceById(Number(req.body?.id))
  if (!inst) return res.json(err('实例不存在'))
  const def = await repo.findDefineById(inst.defineId)
  const records = (inst.tasks ?? [])
    .slice()
    .sort((a: any, b: any) => a.id - b.id)
    .map((t: any) => taskVo(t, inst, def))
  res.json(ok(records))
})

// ─── 流程任务 ────────────────────────────────────────────────────────────────────

app.post('/wf/processTask/todoList', async (req, res) => {
  const userId = String(req.body?.operator ?? 'user1')
  const rows: any[] = []
  for (const t of repo.allTasks()) {
    if (t.taskState !== TaskState.Doing) continue
    const actors = await repo.findTaskActors(t.id)
    if (!t.actorIds.includes(userId) && !actors.includes(userId)) continue
    const inst = await repo.findInstanceById(t.processInstanceId)
    const def = inst ? await repo.findDefineById(inst.defineId) : null
    rows.push(taskVo(t, inst, def))
  }
  rows.sort((a, b) => b.id - a.id)
  res.json(ok(page(rows)))
})

app.post('/wf/processTask/doneList', async (req, res) => {
  const userId = String(req.body?.operator ?? 'user1')
  const rows: any[] = []
  for (const t of repo.allTasks()) {
    if (t.taskState !== TaskState.Done) continue
    const actors = await repo.findTaskActors(t.id)
    if (!t.actorIds.includes(userId) && !actors.includes(userId) && t.actorId !== userId) continue
    const inst = await repo.findInstanceById(t.processInstanceId)
    const def = inst ? await repo.findDefineById(inst.defineId) : null
    rows.push(taskVo(t, inst, def))
  }
  rows.sort((a, b) => b.id - a.id)
  res.json(ok(page(rows)))
})

app.post('/wf/processTask/execute', async (req, res) => {
  const { processTaskId, operator = 'user1', submitType = AGREE, ...rest } = req.body ?? {}
  const taskId = Number(processTaskId)
  const st = Number(submitType)
  const args: Record<string, any> = { ...rest }
  try {
    if (st === REJECT) {                       // 2 拒绝 → 跳结束（实例→45）
      await engine.executeAndJumpToEnd(taskId, operator, args)
    } else if (st === ROLLBACK) {              // 3 退回上一步（回溯上一任务节点）
      await rollbackToPrev(taskId, operator, args)
    } else if (st === JUMP) {                  // 4 跳指定节点
      await engine.executeAndJumpTask(taskId, operator, args, String(args.taskName ?? ''))
    } else if (st === ROLLBACK_TO_OPERATOR) {  // 6 退回发起人（第一个任务节点）
      await engine.executeAndJumpToFirstTaskNode(taskId, operator, args)
    } else if (st === COUNTERSIGN_DISAGREE) {  // 20 会签不同意
      args.countersignDisagreeFlag = 1
      await engine.executeProcessTask(taskId, operator, args)
    } else {                                   // 0/1/5 及默认 → 执行
      await engine.executeProcessTask(taskId, operator, args)
    }
    res.json(ok())
  } catch (e: any) { res.json(err(e.message)) }
})

async function rollbackToPrev(taskId: number, operator: string, args: Record<string, any>) {
  // 退回上一步：找到当前任务节点的上一个任务节点并跳转
  const task = await repo.findTaskById(taskId)
  const inst = task ? await repo.findInstanceById(task.processInstanceId) : null
  if (!task || !inst) return engine.executeAndJumpToEnd(taskId, operator, args)
  const def = await repo.findDefineById(inst.defineId)
  const graph = parseContent(def)
  if (!graph) return engine.executeAndJumpToEnd(taskId, operator, args)
  // 找当前节点的上一个节点
  let prev: string | undefined
  for (const e of graph.edges ?? []) {
    if (e.targetNodeId === task.taskName) { prev = e.sourceNodeId; break }
  }
  // 沿 prev 回溯到任务节点
  let target: string | undefined = prev
  const seen = new Set<string>()
  while (target) {
    if (seen.has(target)) break
    seen.add(target)
    const node = (graph.nodes ?? []).find((n: any) => n.id === target)
    if (!node) break
    if (node.type === 'snaker:task' || node.type === 'snaker:custom') break
    let found: string | undefined
    for (const e of graph.edges ?? []) {
      if (e.targetNodeId === target) { found = e.sourceNodeId; break }
    }
    target = found
  }
  if (target) await engine.executeAndJumpTask(taskId, operator, args, target)
  else await engine.executeAndJumpToEnd(taskId, operator, args)
}

app.post('/wf/processTask/jumpAbleTaskNameList', async (req, res) => {
  const instanceId = Number(req.body?.processInstanceId)
  const done = await repo.findDoneTasks(instanceId)
  const seen = new Set<string>()
  const rows: any[] = []
  for (const t of done) {
    if (!seen.has(t.taskName)) {
      seen.add(t.taskName)
      rows.push({ label: t.displayName, value: t.taskName })
    }
  }
  res.json(ok(rows))
})

app.listen(8082, () => console.log('jeeflow-node → http://localhost:8082'))
