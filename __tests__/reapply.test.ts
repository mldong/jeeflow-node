import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EngineImpl, KeySubmitType } from '../src/engine.js'
import { MemoryRepository } from '../src/memory.js'
import { InstanceState, SubmitType, TaskState, type ProcessDefine, type ProcessInstance, type ProcessTask } from '../src/model.js'
import type { ExpressionEvaluator, UserProvider } from '../src/spi.js'
import { dir as flowsResolverDir } from '../flows-resolver.js'

const flowDir = flowsResolverDir() + '/'

function setup() {
  const repo = new MemoryRepository()
  const userProv: UserProvider = {
    async getUser(userId: string) { return { userId, realName: '用户' + userId, deptId: 'D01', deptName: '测试部门', postId: 'P01', postName: '测试岗位' } },
  }
  let n = 0
  const base = Date.now() * 1000
  const idGen = { nextId() { n += 1; return String(base + n) } }
  const exprEval: ExpressionEvaluator = {
    async eval(expr: string, vars: Record<string, any>) {
      const amt = Number(vars.amount ?? 0)
      if (expr === 'amount > 1000') return amt > 1000
      if (expr === 'amount <= 1000') return amt <= 1000
      return false
    },
  }
  return { engine: new EngineImpl(repo, userProv, idGen as any, exprEval), repo }
}

function loadFlow(repo: MemoryRepository, filename: string): ProcessDefine {
  const raw = JSON.parse(readFileSync(flowDir + filename, 'utf-8'))
  const def: ProcessDefine = {
    id: '', name: raw.name ?? filename, displayName: raw.displayName ?? filename,
    type: raw.type ?? '', state: 1, content: JSON.stringify(raw), version: 1,
  } as ProcessDefine
  repo.addDefine(def)
  return def
}

async function start(engine: any, repo: MemoryRepository, defineId: string, operator = 'applicant', args: Record<string, any> = {}) {
  const inst = await engine.startProcessInstanceById(defineId, operator, args)
  for (const t of await repo.findDoingTasks(inst.id)) {
    if (t.taskName === 'apply') {
      await repo.addTaskActor(t.id, [operator])
      await engine.executeProcessTask(t.id, operator)
    }
  }
  return (await repo.findInstanceById(inst.id))!
}

async function doing(repo: MemoryRepository, iid: string, name: string): Promise<ProcessTask | undefined> {
  return (await repo.findDoingTasks(iid)).find(t => t.taskName === name)
}

async function act(repo: MemoryRepository, task: ProcessTask, operator: string) {
  await repo.addTaskActor(task.id, [operator])
  if (!task.actorIds.includes(operator)) task.actorIds.push(operator)
}

async function execute(engine: any, repo: MemoryRepository, task: ProcessTask, operator: string, submit: number) {
  await act(repo, task, operator)
  return engine.executeProcessTask(task.id, operator, { [KeySubmitType]: submit })
}

async function ret(engine: any, repo: MemoryRepository, task: ProcessTask, operator: string) {
  await act(repo, task, operator)
  return engine.executeAndJumpToFirstTaskNode(task.id, operator, { [KeySubmitType]: SubmitType.RollbackToOperator })
}

describe('退回修改、重提直返（Node）', () => {
  it('基本直返：只生成来源节点的新待办', async () => {
    const { engine, repo } = setup()
    const def = loadFlow(repo, '14-return-to-source.json')
    const inst = await start(engine, repo, def.id)
    await ret(engine, repo, (await doing(repo, inst.id, 'taskA'))!, 'userA')
    const app = await doing(repo, inst.id, 'apply')
    assert.ok(app, 'applicant task not created')
    assert.ok(app!.variables._reapplyContext, JSON.stringify(app!.variables))
    assert.equal(await doing(repo, inst.id, 'taskB'), undefined)
    await execute(engine, repo, app!, 'applicant', SubmitType.ReApply)
    const newA = await doing(repo, inst.id, 'taskA')
    assert.ok(newA)
    assert.equal(newA!.parentTaskId, app!.id)
    assert.equal(await doing(repo, inst.id, 'taskB'), undefined)
    await execute(engine, repo, newA!, 'userA', SubmitType.Agree)
    const b = await doing(repo, inst.id, 'taskB')
    assert.ok(b)
    await execute(engine, repo, b!, 'userB', SubmitType.Agree)
    assert.equal((await repo.findInstanceById(inst.id))!.state, InstanceState.Done)
  })

  it('直返申请待办拒绝普通同意', async () => {
    const { engine, repo } = setup()
    const def = loadFlow(repo, '14-return-to-source.json')
    const inst = await start(engine, repo, def.id)
    await ret(engine, repo, (await doing(repo, inst.id, 'taskA'))!, 'userA')
    const app = (await doing(repo, inst.id, 'apply'))!
    await act(repo, app, 'applicant')
    await assert.rejects(() => engine.executeProcessTask(app.id, 'applicant', { [KeySubmitType]: SubmitType.Agree }))
    assert.equal(await doing(repo, inst.id, 'taskA'), undefined)
  })

  it('未汇合并行：申请人修改期间不放行；重提本身不放行；放行一次', async () => {
    const { engine, repo } = setup()
    const def = loadFlow(repo, '15-return-to-source-fork.json')
    const inst = await start(engine, repo, def.id)
    const a = (await doing(repo, inst.id, 'taskA'))!
    const b = (await doing(repo, inst.id, 'taskB'))!
    assert.ok(a && b)
    await ret(engine, repo, a, 'userA')
    assert.ok(await doing(repo, inst.id, 'taskB'))
    await execute(engine, repo, b, 'userB', SubmitType.Agree)
    assert.equal(await doing(repo, inst.id, 'taskC'), undefined, 'join must wait while applicant edits')
    const app = (await doing(repo, inst.id, 'apply'))!
    await execute(engine, repo, app, 'applicant', SubmitType.ReApply)
    const newA = (await doing(repo, inst.id, 'taskA'))!
    assert.ok(newA)
    assert.equal(await doing(repo, inst.id, 'taskB'), undefined, 'branch B must not be recreated')
    assert.equal(await doing(repo, inst.id, 'taskC'), undefined, 'reapply alone must not release join')
    await execute(engine, repo, newA, 'userA', SubmitType.Agree)
    assert.ok(await doing(repo, inst.id, 'taskC'))
    assert.equal((await repo.findDoingTasks(inst.id)).length, 1, 'join releases exactly once')
  })

  it('两条分支分别退回', async () => {
    const { engine, repo } = setup()
    const def = loadFlow(repo, '15-return-to-source-fork.json')
    const inst = await start(engine, repo, def.id)
    await ret(engine, repo, (await doing(repo, inst.id, 'taskA'))!, 'userA')
    await ret(engine, repo, (await doing(repo, inst.id, 'taskB'))!, 'userB')
    const apps = await repo.findDoingTasks(inst.id, ['apply'])
    assert.equal(apps.length, 2, `two applicant tasks expected, got ${apps.length}`)
    const appA = apps.find(x => (x.variables._reapplyContext ?? {}).sourceNode === 'taskA')!
    const appB = apps.find(x => (x.variables._reapplyContext ?? {}).sourceNode === 'taskB')!
    assert.ok(appA && appB)
    await execute(engine, repo, appA, 'applicant', SubmitType.ReApply)
    assert.equal((await repo.findDoingTasks(inst.id, ['apply'])).length, 1)
    await execute(engine, repo, (await doing(repo, inst.id, 'taskA'))!, 'userA', SubmitType.Agree)
    assert.equal(await doing(repo, inst.id, 'taskC'), undefined)
    await execute(engine, repo, appB, 'applicant', SubmitType.ReApply)
    await execute(engine, repo, (await doing(repo, inst.id, 'taskB'))!, 'userB', SubmitType.Agree)
    assert.ok(await doing(repo, inst.id, 'taskC'))
  })

  it('条件分支不重算来源前条件', async () => {
    const { engine, repo } = setup()
    const def = loadFlow(repo, '16-return-to-source-decision.json')
    const inst = await start(engine, repo, def.id, 'applicant', { amount: 5000 })
    const high = (await doing(repo, inst.id, 'taskHigh'))!
    assert.ok(high, 'amount>1000 should route to taskHigh')
    await ret(engine, repo, high, 'userH')
    const app = (await doing(repo, inst.id, 'apply'))!
    await act(repo, app, 'applicant')
    await engine.executeProcessTask(app.id, 'applicant', { [KeySubmitType]: SubmitType.ReApply, amount: 100 })
    assert.ok(await doing(repo, inst.id, 'taskHigh'))
    assert.equal(await doing(repo, inst.id, 'taskLow'), undefined, 'pre-source condition must not be re-evaluated')
  })

  it('重复退回绑定本轮来源', async () => {
    const { engine, repo } = setup()
    const def = loadFlow(repo, '14-return-to-source.json')
    const inst = await start(engine, repo, def.id)
    await ret(engine, repo, (await doing(repo, inst.id, 'taskA'))!, 'userA')
    await execute(engine, repo, (await doing(repo, inst.id, 'apply'))!, 'applicant', SubmitType.ReApply)
    const round2 = (await doing(repo, inst.id, 'taskA'))!
    await ret(engine, repo, round2, 'userA')
    const app2 = (await doing(repo, inst.id, 'apply'))!
    assert.equal(String(app2.variables._reapplyContext.sourceTaskId), round2.id)
  })

  it('并发重提至多一个成功', async () => {
    const { engine, repo } = setup()
    const def = loadFlow(repo, '14-return-to-source.json')
    const inst = await start(engine, repo, def.id)
    await ret(engine, repo, (await doing(repo, inst.id, 'taskA'))!, 'userA')
    const app = (await doing(repo, inst.id, 'apply'))!
    await act(repo, app, 'applicant')
    const one = async () => {
      try { await engine.executeProcessTask(app.id, 'applicant', { [KeySubmitType]: SubmitType.ReApply }); return true }
      catch { return false }
    }
    const results = await Promise.all([one(), one()])
    assert.equal(results.filter(Boolean).length, 1, JSON.stringify(results))
    assert.equal((await repo.findDoingTasks(inst.id, ['taskA'])).length, 1)
  })

  it('带直返标记的申请待办走真实跳转入口必须失败且无写入', async () => {
    const { engine, repo } = setup()
    const def = loadFlow(repo, '14-return-to-source.json')
    const inst = await start(engine, repo, def.id)
    await ret(engine, repo, (await doing(repo, inst.id, 'taskA'))!, 'userA')
    const app = (await doing(repo, inst.id, 'apply'))!
    await act(repo, app, 'applicant')
    const doingBefore = (await repo.findDoingTasks(inst.id)).length
    const histBefore = (await repo.findHistoryTasks(inst.id)).length

    await assert.rejects(
      () => engine.executeAndJumpTask(app.id, 'applicant', { [KeySubmitType]: SubmitType.Jump }, 'taskB'),
      /只接受重新提交/)
    await assert.rejects(
      () => engine.executeAndJumpTask(app.id, 'applicant', { [KeySubmitType]: SubmitType.Rollback }),
      /只接受重新提交/)
    await assert.rejects(
      () => engine.executeAndJumpToEnd(app.id, 'applicant', { [KeySubmitType]: SubmitType.Reject }),
      /只接受重新提交/)
    await assert.rejects(
      () => engine.executeAndJumpToFirstTaskNode(app.id, 'applicant', { [KeySubmitType]: SubmitType.RollbackToOperator }),
      /只接受重新提交/)

    assert.equal((await repo.findDoingTasks(inst.id)).length, doingBefore)
    assert.equal((await repo.findHistoryTasks(inst.id)).length, histBefore)
    const again = (await repo.findTaskById(app.id))!
    assert.equal(again.taskState, TaskState.Doing)
    assert.ok(again.variables._reapplyContext)
    await execute(engine, repo, again, 'applicant', SubmitType.ReApply)
    assert.ok(await doing(repo, inst.id, 'taskA'))
  })

  it('未配置 reapplyMode 的节点仍走原路', async () => {
    const { engine, repo } = setup()
    const def = loadFlow(repo, '04-fork-join.json')
    const inst = await start(engine, repo, def.id)
    await ret(engine, repo, (await doing(repo, inst.id, 'taskA'))!, 'userA')
    const app = (await doing(repo, inst.id, 'apply'))!
    assert.equal(app.variables._reapplyContext, undefined)
    await execute(engine, repo, app, 'applicant', SubmitType.ReApply)
    assert.equal((await repo.findDoingTasks(inst.id)).length, 3, 'legacy reapply should re-fork')
  })

  it('嵌套并行：内层来源分支退回时内外汇合都保持等待', async () => {
    const { engine, repo } = setup()
    const def = loadFlow(repo, '18-return-to-source-nested.json')
    const inst = await start(engine, repo, def.id)
    const a = (await doing(repo, inst.id, 'taskA'))!
    const b = (await doing(repo, inst.id, 'taskB'))!
    assert.ok(a && b)
    await execute(engine, repo, a, 'userA', SubmitType.Agree)
    const x = (await doing(repo, inst.id, 'taskX'))!
    const y = (await doing(repo, inst.id, 'taskY'))!
    assert.ok(x && y)
    await ret(engine, repo, x, 'userX')
    assert.ok(await doing(repo, inst.id, 'apply'), 'applicant task not created')
    await execute(engine, repo, y, 'userY', SubmitType.Agree)
    assert.equal(await doing(repo, inst.id, 'taskA2'), undefined, 'inner join must wait while applicant edits')
    const app = (await doing(repo, inst.id, 'apply'))!
    await execute(engine, repo, app, 'applicant', SubmitType.ReApply)
    const newX = (await doing(repo, inst.id, 'taskX'))!
    assert.ok(newX, 'reapply should recreate inner source task')
    assert.equal(await doing(repo, inst.id, 'taskY'), undefined, 'inner branch Y must not be recreated')
    assert.equal(await doing(repo, inst.id, 'taskA2'), undefined, 'reapply alone must not release inner join')
    await execute(engine, repo, newX, 'userX', SubmitType.Agree)
    const hist = async (name: string) =>
      (await repo.findHistoryTasks(inst.id)).filter(t => t.taskName === name).length
    assert.equal(await hist('taskA2'), 1, 'inner join releases exactly once')
    await execute(engine, repo, (await doing(repo, inst.id, 'taskA2'))!, 'userA', SubmitType.Agree)
    assert.equal(await doing(repo, inst.id, 'taskC'), undefined, 'outer join must wait for branch B')
    await execute(engine, repo, b, 'userB', SubmitType.Agree)
    assert.equal(await hist('taskC'), 1, 'outer join releases exactly once')
  })
})
