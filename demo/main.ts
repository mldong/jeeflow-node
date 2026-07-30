// jeeflow-node Express demo — 对齐 Java/Go 版 REST 路径
import express from 'express'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EngineImpl } from '../src/engine.js'
import { MemoryRepository } from '../src/memory.js'
import type { ProcessDefine } from '../src/model.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const repo = new MemoryRepository()
const engine = new EngineImpl(repo)

// ─── 预置流程 ──────────────────────────────────────────────────────────────────
const flows: ProcessDefine[] = [
  { id: 1, name: 'leave', displayName: '请假审批', type: 'approval', state: 1, version: 1,
    content: `{"name":"leave","displayName":"请假审批","type":"approval","nodes":[{"id":"start","type":"snaker:start","x":100,"y":200,"properties":{},"text":{"value":"开始"}},{"id":"task1","type":"snaker:task","x":300,"y":200,"properties":{"form":"leave-form","assignee":"leader","taskType":0,"performType":0},"text":{"value":"组长审批"}},{"id":"end","type":"snaker:end","x":500,"y":200,"properties":{},"text":{"value":"结束"}}],"edges":[{"id":"e1","sourceNodeId":"start","targetNodeId":"task1","properties":{}},{"id":"e2","sourceNodeId":"task1","targetNodeId":"end","properties":{}}]}`,
    createTime: new Date(), updateTime: new Date(), createUser: '', updateUser: '' },
  { id: 2, name: 'three-level', displayName: '三级审批', type: 'approval', state: 1, version: 1,
    content: `{"name":"three-level","displayName":"三级审批","type":"approval","nodes":[{"id":"start","type":"snaker:start","x":100,"y":200,"properties":{},"text":{"value":"开始"}},{"id":"t1","type":"snaker:task","x":250,"y":200,"properties":{"form":"approval-form","assignee":"leader","taskType":0,"performType":0},"text":{"value":"组长审批"}},{"id":"t2","type":"snaker:task","x":400,"y":200,"properties":{"form":"approval-form","assignee":"manager","taskType":0,"performType":0},"text":{"value":"经理审批"}},{"id":"t3","type":"snaker:task","x":550,"y":200,"properties":{"form":"approval-form","assignee":"boss","taskType":0,"performType":0},"text":{"value":"总监审批"}},{"id":"end","type":"snaker:end","x":700,"y":200,"properties":{},"text":{"value":"结束"}}],"edges":[{"id":"e1","sourceNodeId":"start","targetNodeId":"t1","properties":{}},{"id":"e2","sourceNodeId":"t1","targetNodeId":"t2","properties":{}},{"id":"e3","sourceNodeId":"t2","targetNodeId":"t3","properties":{}},{"id":"e4","sourceNodeId":"t3","targetNodeId":"end","properties":{}}]}`,
    createTime: new Date(), updateTime: new Date(), createUser: '', updateUser: '' },
  { id: 3, name: 'expense', displayName: '报销审批', type: 'finance', state: 1, version: 1,
    content: `{"name":"expense","displayName":"报销审批","type":"finance","nodes":[{"id":"start","type":"snaker:start","x":100,"y":200,"properties":{},"text":{"value":"开始"}},{"id":"apply","type":"snaker:task","x":300,"y":200,"properties":{"form":"expense-form","assignee":"leader","taskType":0,"performType":0},"text":{"value":"填写报销单"}},{"id":"decision","type":"snaker:decision","x":500,"y":200,"properties":{"expr":"amount > 1000"},"text":{"value":"金额>1000?"}},{"id":"manager","type":"snaker:task","x":700,"y":100,"properties":{"form":"expense-form","assignee":"manager","taskType":0,"performType":0},"text":{"value":"经理审批"}},{"id":"director","type":"snaker:task","x":700,"y":300,"properties":{"form":"expense-form","assignee":"director","taskType":0,"performType":0},"text":{"value":"总监审批"}},{"id":"end","type":"snaker:end","x":900,"y":200,"properties":{},"text":{"value":"结束"}}],"edges":[{"id":"e1","sourceNodeId":"start","targetNodeId":"apply","properties":{}},{"id":"e2","sourceNodeId":"apply","targetNodeId":"decision","properties":{}},{"id":"e3","sourceNodeId":"decision","targetNodeId":"manager","properties":{"expr":"amount > 1000"},"text":{"value":"金额>1000"}},{"id":"e4","sourceNodeId":"decision","targetNodeId":"director","properties":{"expr":"amount <= 1000"},"text":{"value":"金额≤1000"}},{"id":"e5","sourceNodeId":"manager","targetNodeId":"end","properties":{}},{"id":"e6","sourceNodeId":"director","targetNodeId":"end","properties":{}}]}`,
    createTime: new Date(), updateTime: new Date(), createUser: '', updateUser: '' },
]
flows.forEach(f => repo.addDefine(f))

const app = express()
app.use(express.json())

// 静态文件
app.get('/', (_req, res) => res.sendFile(join(__dirname, 'web', 'index.html')))

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

app.post('/wf/processInstance/startAndExecute', async (req, res) => {
  const { processDefineId, operator = 'user1', amount } = req.body
  const inst = await engine.startProcessInstanceById(Number(processDefineId), operator, { BUSINESS_NO: 'BIZ-' + Date.now(), amount: Number(amount ?? 0) })
  res.json({ code: 200, data: { processInstanceId: String(inst.id) } })
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
    if (Number(submitType) === 1) await engine.executeProcessTask(Number(processTaskId), operator, args)
    else await engine.executeAndJumpToEnd(Number(processTaskId), operator, args)
    res.json({ code: 200, data: { message: '处理成功' } })
  } catch (e: any) { res.json({ code: 500, message: e.message }) }
})

app.listen(8082, () => console.log('jeeflow-node → http://localhost:8082'))
