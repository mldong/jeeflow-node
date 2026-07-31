import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EngineImpl } from '../src/engine.js'
import { MemoryRepository } from '../src/memory.js'
import { InstanceState, type ProcessDefine, type ProcessInstance, type ProcessTask } from '../src/model.js'
import type { ExpressionEvaluator, UserProvider } from '../src/spi.js'
import { type FlowInterceptor, EventType, type EngineExtensions } from '../src/extensions.js'

const flowDir = '../jeeflow-java/jeeflow-core/src/test/resources/flows/'

function setup() {
  const repo = new MemoryRepository()
  const userProv: UserProvider = {
    async getUser(userId) { return { userId, realName: '用户' + userId, deptId: 'D01', deptName: '测试部门', postId: 'P01', postName: '测试岗位' } },
  }
  const idGen = { nextId() { return Date.now() * 1000 + Math.floor(Math.random() * 1000) } }
  const exprEval: ExpressionEvaluator = {
    async eval(expr, vars) {
      const amt = Number(vars.amount ?? 0)
      if (expr === 'amount > 1000') return amt > 1000
      if (expr === 'amount <= 1000') return amt <= 1000
      return false
    },
  }
  return { engine: new EngineImpl(repo, userProv, idGen, exprEval), repo }
}

function loadFlow(repo: MemoryRepository, filename: string): ProcessDefine {
  const data = readFileSync(flowDir + filename, 'utf-8')
  const def: ProcessDefine = { id: 0, name: filename, displayName: filename, type: 'test', state: 1, content: data, version: 1, createTime: new Date(), updateTime: new Date(), createUser: '', updateUser: '' }
  repo.addDefine(def)
  return def
}


async function startAndExecute(engine: EngineImpl, repo: MemoryRepository, defineId: number, operator: string, args?: Record<string, any>) {
  const inst = await engine.startProcessInstanceById(defineId, operator, args)
  const doing = await repo.findDoingTasks(inst.id)
  for (const task of doing) {
    if (task.taskName === 'apply') {
      await repo.addTaskActor(task.id, [operator])
      await engine.executeProcessTask(task.id, operator)
    }
  }
  return inst
}

async function assertDone(inst: ProcessInstance | null, msg: string) {
  assert.equal(inst?.state, InstanceState.Done, msg)
}

describe('jeeflow compliance tests', () => {

  it('01 simple flow', async () => {
    const { engine, repo } = setup()
    const def = loadFlow(repo, '01-simple.json')
    const inst = await startAndExecute(engine, repo, def.id, 'applicant')
    const doing = await repo.findDoingTasks(inst.id)
    assert.equal(doing.length, 1)
    assert.equal(doing[0].taskName, 'task1')
    await repo.addTaskActor(doing[0].id, ['applicant'])
    doing[0].actorIds.push('applicant')
    const result = await engine.executeProcessTask(doing[0].id, 'applicant')
    await assertDone(result, 'simple: expected done')
  })

  it('02 multi-task', async () => {
    const { engine, repo } = setup()
    const def = loadFlow(repo, '02-multi-task.json')
    const inst = await startAndExecute(engine, repo, def.id, 'applicant')

    let doing = await repo.findDoingTasks(inst.id)
    assert.equal(doing.length, 1, 'task1')
    assert.equal(doing[0].taskName, 'task1')
    await repo.addTaskActor(doing[0].id, ['userA'])
    doing[0].actorIds.push('userA')
    await engine.executeProcessTask(doing[0].id, 'userA')

    doing = await repo.findDoingTasks(inst.id)
    assert.equal(doing.length, 1, 'task2')
    assert.equal(doing[0].taskName, 'task2')
    await repo.addTaskActor(doing[0].id, ['userB'])
    doing[0].actorIds.push('userB')
    await engine.executeProcessTask(doing[0].id, 'userB')

    doing = await repo.findDoingTasks(inst.id)
    assert.equal(doing.length, 1, 'task3')
    assert.equal(doing[0].taskName, 'task3')
    await repo.addTaskActor(doing[0].id, ['userC'])
    doing[0].actorIds.push('userC')
    const result = await engine.executeProcessTask(doing[0].id, 'userC')
    await assertDone(result, 'multi: expected done')
  })

  it('03 decision', async () => {
    const { engine, repo } = setup()
    const def = loadFlow(repo, '03-decision-expr.json')
    const inst = await startAndExecute(engine, repo, def.id, 'applicant', { amount: 3000 })
    let doing = await repo.findDoingTasks(inst.id)
    await repo.addTaskActor(doing[0].id, ['applicant'])
    doing[0].actorIds.push('applicant')
    await engine.executeProcessTask(doing[0].id, 'applicant')
    doing = await repo.findDoingTasks(inst.id)
    assert.equal(doing[0].taskName, 'task2', 'amount>1000 → task2')
  })

  it('04 fork-join', async () => {
    const { engine, repo } = setup()
    const def = loadFlow(repo, '04-fork-join.json')
    const inst = await startAndExecute(engine, repo, def.id, 'applicant')
    let doing = await repo.findDoingTasks(inst.id)
    assert.equal(doing.length, 2, 'fork: 2 tasks')
    const tA = doing.find(t => t.taskName === 'taskA')!
    const tB = doing.find(t => t.taskName === 'taskB')!
    await repo.addTaskActor(tA.id, ['userA'])
    tA.actorIds.push('userA')
    await engine.executeProcessTask(tA.id, 'userA')
    let inst2 = await repo.findInstanceById(inst.id)
    assert.equal(inst2?.state, InstanceState.Doing, 'still doing')
    await repo.addTaskActor(tB.id, ['userB'])
    tB.actorIds.push('userB')
    const result = await engine.executeProcessTask(tB.id, 'userB')
    await assertDone(result, 'fork-join: expected done')
  })

  it('05 countersign parallel', async () => {
    const { engine, repo } = setup()
    const def = loadFlow(repo, '05-countersign-parallel.json')
    const inst = await startAndExecute(engine, repo, def.id, 'applicant')
    let doing = await repo.findDoingTasks(inst.id)
    assert.equal(doing.length, 3, 'parallel cs: 3 tasks')
    for (const actor of ['userA', 'userB', 'userC']) {
      doing = await repo.findDoingTasks(inst.id)
      const t = doing[0]
      await repo.addTaskActor(t.id, [actor])
      t.actorIds.push(actor)
      await engine.executeProcessTask(t.id, actor)
    }
    const result = await repo.findInstanceById(inst.id)
    await assertDone(result, 'parallel cs: expected done')
  })

  it('06 countersign sequential', async () => {
    const { engine, repo } = setup()
    const def = loadFlow(repo, '06-countersign-sequential.json')
    const inst = await startAndExecute(engine, repo, def.id, 'applicant')
    let doing = await repo.findDoingTasks(inst.id)
    assert.equal(doing.length, 1, 'seq cs: 1 task')
    let t = doing[0]
    await repo.addTaskActor(t.id, ['userA'])
    t.actorIds.push('userA')
    await engine.executeProcessTask(t.id, 'userA')
    doing = await repo.findDoingTasks(inst.id)
    assert.equal(doing.length, 1, 'seq cs step2: 1 task')
    t = doing[0]
    await repo.addTaskActor(t.id, ['userB'])
    t.actorIds.push('userB')
    const result = await engine.executeProcessTask(t.id, 'userB')
    await assertDone(result, 'seq cs: expected done')
  })

  it('07 countersign ratio', async () => {
    const { engine, repo } = setup()
    const def = loadFlow(repo, '07-countersign-ratio.json')
    const inst = await startAndExecute(engine, repo, def.id, 'applicant')
    let doing = await repo.findDoingTasks(inst.id)
    assert.equal(doing.length, 4, 'ratio cs: 4 tasks')
    for (const actor of ['userA', 'userB', 'userC', 'userD']) {
      doing = await repo.findDoingTasks(inst.id)
      const t = doing[0]
      await repo.addTaskActor(t.id, [actor])
      t.actorIds.push(actor)
      await engine.executeProcessTask(t.id, actor)
    }
    const result = await repo.findInstanceById(inst.id)
    await assertDone(result, 'ratio cs: expected done')
  })

  it('08 reject', async () => {
    const { engine, repo } = setup()
    const def = loadFlow(repo, '02-multi-task.json')
    const inst = await startAndExecute(engine, repo, def.id, 'applicant')
    const doing = await repo.findDoingTasks(inst.id)
    await repo.addTaskActor(doing[0].id, ['applicant'])
    doing[0].actorIds.push('applicant')
    const result = await engine.executeAndJumpToEnd(doing[0].id, 'applicant')
    assert.equal(result.state, InstanceState.Reject, 'reject: expected 45')
  })

  it('09 permission', async () => {
    const { engine, repo } = setup()
    const def = loadFlow(repo, '02-multi-task.json')
    const inst = await startAndExecute(engine, repo, def.id, 'applicant')
    const doing = await repo.findDoingTasks(inst.id)
    await repo.addTaskActor(doing[0].id, ['leader'])
    doing[0].actorIds = ['leader']
    await assert.rejects(() => engine.executeProcessTask(doing[0].id, 'intruder'), /not allowed/)
  })

  it('10 interceptor + events', async () => {
    const { engine, repo } = setup()
    const def = loadFlow(repo, '01-simple.json')
    let preCalled = false, postCalled = false
    const events: string[] = []
    engine.setExtensions({
      interceptors: [{ order: 1,
        async preHandle() { preCalled = true; return true },
        async postHandle() { postCalled = true },
      }],
      listeners: [(e) => {
        if (e.type === EventType.ProcessStart) events.push('start')
        if (e.type === EventType.TaskComplete) events.push('taskDone')
        if (e.type === EventType.ProcessFinish) events.push('finish')
      }],
    })
    const inst = await startAndExecute(engine, repo, def.id, 'applicant')
    const doing = await repo.findDoingTasks(inst.id)
    await repo.addTaskActor(doing[0].id, ['leader'])
    doing[0].actorIds.push('leader')
    await engine.executeProcessTask(doing[0].id, 'leader')
    assert.ok(preCalled)
    assert.ok(postCalled)
    // start + apply自动完成 + task1 + finish
    assert.deepStrictEqual(events, ['start', 'taskDone', 'taskDone', 'finish'])
  })
})
