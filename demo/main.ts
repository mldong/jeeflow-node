// jeeflow-node Express demo — 对齐 Java/Go/Python 版 REST 路径
import express from 'express'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EngineImpl } from '../src/engine.js'
import { MemoryRepository } from '../src/memory.js'
import type { ProcessDefine } from '../src/model.js'

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

// ─── API ──────────────────────────────────────────────────────────────────────

app.get('/api/stats', async (req, res) => {
  const userId = String(req.query.userId ?? 'user1')
  let count = 0
  for (const t of repo.allTasks()) {
    if (t.taskState === 10) {
      const actors = await repo.findTaskActors(t.id)
      if (t.actorIds.includes(userId) || actors.includes(userId)) count++
    }
  }
  let instCount = 0
  for (const inst of repo.allInstances()) if (inst.operator === userId) instCount++
  res.json({ code: 200, data: { todoCount: count, myInstanceCount: instCount } })
})

app.post('/wf/processDefine/page', (_req, res) => {
  res.json({ code: 200, data: { rows: repo.allDefines().map(d => ({ id: d.id, name: d.name, displayName: d.displayName })) } })
})

app.post('/wf/processDefine/detail', async (req, res) => {
  const def = repo.allDefines().find(d => d.id === Number(req.body.id))
  if (!def) return res.json({ code: 500, message: '流程定义不存在' })
  res.json({ code: 200, data: { id: def.id, name: def.name, displayName: def.displayName,
    type: def.type, state: def.state, version: def.version,
    graphData: JSON.parse(def.content) } })
})

app.post('/wf/processInstance/startAndExecute', async (req, res) => {
  try {
    const { processDefineId, operator = 'user1', amount } = req.body
    const inst = await engine.startProcessInstanceById(Number(processDefineId), operator, { BUSINESS_NO: 'BIZ-' + Date.now(), amount: Number(amount ?? 0) })
    // boot2 契约：自动完成申请节点
    const doing = await repo.findDoingTasks(inst.id)
    for (const task of doing) {
      await repo.addTaskActor(task.id, [operator])
      await engine.executeProcessTask(task.id, operator, { submitType: 0 }) // APPLY
    }
    res.json({ code: 200, data: { processInstanceId: String(inst.id) } })
  } catch (e: any) { res.json({ code: 500, message: e.message }) }
})

app.post('/wf/processInstance/page', (_req, res) => {
  const rows = repo.allInstances().map(i => {
    const def = repo.allDefines().find(d => d.id === i.defineId)
    return { id: i.id, processDefineId: i.defineId, state: i.state, operator: i.operator,
      createTime: i.createTime.toISOString(), processDefineName: def?.displayName ?? '', processDefineDisplayName: def?.displayName ?? '' }
  })
  res.json({ code: 200, data: { rows, pageNum: 1, pageSize: 100, recordCount: rows.length } })
})

app.post('/wf/processInstance/detail', async (req, res) => {
  const inst = await repo.findInstanceById(Number(req.body.id))
  if (!inst) return res.json({ code: 500, message: '实例不存在' })
  const tasks = await repo.findHistoryTasks(inst.id)
  res.json({ code: 200, data: { id: String(inst.id), state: inst.state, operator: inst.operator,
    createTime: inst.createTime.toISOString(),
    approvalRecords: tasks.map(t => ({ id: t.id, taskName: t.taskName, displayName: t.displayName,
      taskState: t.taskState, operator: t.actorId, createTime: t.createTime.toISOString(),
      finishTime: t.finishTime?.toISOString() ?? null })) } })
})

app.post('/wf/processTask/todoList', async (req, res) => {
  const rows: any[] = []
  for (const t of repo.allTasks()) {
    if (t.taskState !== 10) continue
    const actors = await repo.findTaskActors(t.id)
    if (!t.actorIds.includes(req.body.userId) && !actors.includes(req.body.userId)) continue
    const inst = await repo.findInstanceById(t.processInstanceId)
    const def = inst ? repo.allDefines().find(d => d.id === inst.defineId) : null
    rows.push({ id: t.id, taskName: t.taskName, displayName: t.displayName, taskState: t.taskState,
      processInstanceId: t.processInstanceId, createTime: t.createTime.toISOString(),
      processDefineName: def?.displayName ?? '', processDefineDisplayName: def?.displayName ?? '' })
  }
  res.json({ code: 200, data: { rows, pageNum: 1, pageSize: 100, recordCount: rows.length } })
})

app.post('/wf/processTask/execute', async (req, res) => {
  try {
    const { processTaskId, operator, submitType } = req.body
    const args = { submitType: Number(submitType) }
    switch (Number(submitType)) {
      case 0: // APPLY
      case 1: // AGREE
        await engine.executeProcessTask(Number(processTaskId), operator, args)
        break
      case 2: // REJECT → jump back to apply node
        await engine.executeAndJumpTask(Number(processTaskId), operator, args, 'apply')
        break
      default:
        await engine.executeProcessTask(Number(processTaskId), operator, args)
    }
    res.json({ code: 200, data: { message: '处理成功' } })
  } catch (e: any) { res.json({ code: 500, message: e.message }) }
})

app.listen(8082, () => console.log('jeeflow-node → http://localhost:8082'))
