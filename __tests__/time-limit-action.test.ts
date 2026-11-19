/**
 * 任务时限动作 T0（spec 04 · 任务时限动作；工作流时限方案 §8 的引擎侧判据，Node 腿）。
 *
 * 与 go `engine/timelimit_test.go`、java `TimeLimitActionTest`、python `tests/test_time_limit_action.py` 同构：
 * 建行（autoExecute/reminderTime）、旁路覆盖（主建单/串行会签补建）、不继承档（协办）、
 * 失效联动（办结/实例终态取消）、完成回调事实范围、可注入时钟、实例级排他锁调用面。
 */
import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { EngineImpl, firstReminderTime, KeySubmitType } from '../src/engine.js'
import { MemoryRepository } from '../src/memory.js'
import { SubmitType, type ProcessDefine } from '../src/model.js'
import type { ExpressionEvaluator, TimeAction, TimeActionSink, UserProvider } from '../src/spi.js'

const APPLY = SubmitType.Apply
const AGREE = SubmitType.Agree
const REJECT = SubmitType.Reject

let seq = 0

class Sink implements TimeActionSink {
  actions: TimeAction[] = []
  cancelledTasks: string[] = []
  cancelledInstances: string[] = []
  async insertTimeAction(a: TimeAction) { this.actions.push(a) }
  async cancelTaskTimeActions(id: string) { this.cancelledTasks.push(id) }
  async cancelInstanceTimeActions(id: string) { this.cancelledInstances.push(id) }
  ofType(t: string) { return this.actions.filter(a => a.type === t) }
}

class LockRepo extends MemoryRepository {
  locked: string[] = []
  async lockInstance(id: string) { this.locked.push(id) }
}

function node(id: string, type: string, props: Record<string, any>, text: string) {
  return { id, type, x: 0, y: 0, properties: props, text: { value: text } }
}
function edge(id: string, src: string, dst: string) {
  return { id, type: 'snaker:transition', sourceNodeId: src, targetNodeId: dst, properties: {} }
}

function flow(reviewProps: Record<string, any>) {
  seq += 1
  return {
    name: `tl-${seq}`, displayName: '时限夹具', type: 'approval',
    nodes: [
      node('start', 'snaker:start', {}, '开始'),
      node('apply', 'snaker:task', { form: 'af', taskType: 0, performType: 0, assignee: 'applicant' }, '申请'),
      node('review', 'snaker:task', { form: 'f', taskType: 0, performType: 0, assignee: 'userA', ...reviewProps }, '审批'),
      node('end', 'snaker:end', {}, '结束'),
    ],
    edges: [edge('e1', 'start', 'apply'), edge('e2', 'apply', 'review'), edge('e3', 'review', 'end')],
  }
}

class Harness {
  repo = new LockRepo()
  sink = new Sink()
  eng: EngineImpl
  defineId: string
  now: Date
  constructor(reviewProps: Record<string, any> = {}, now = new Date('2026-11-19T09:00:00')) {
    this.now = now
    const userProv: UserProvider = {
      async getUser(userId: string) {
        return { userId, realName: '用户' + userId, deptId: 'D01', deptName: 'D', postId: 'P', postName: 'P' }
      },
    }
    const base = Date.now() * 1000
    let n = 0
    const idGen = { nextId() { n += 1; return String(base + n) } }
    const exprEval: ExpressionEvaluator = { async eval() { return false } }
    this.eng = new EngineImpl(this.repo, userProv, idGen as any, exprEval,
      { timeActionSink: this.sink, clock: () => this.now })
    const d: ProcessDefine = {
      id: '', name: `tl-${Date.now()}-${seq}`, displayName: '时限夹具', type: 'approval',
      state: 1, version: 1, content: JSON.stringify(flow(reviewProps)),
    } as any
    this.repo.addDefine(d as any)
    this.defineId = (d as any).id
  }

  async startReview() {
    const inst = await this.eng.startProcessInstanceById(this.defineId, 'applicant', {})
    for (const t of await this.repo.findDoingTasks(inst.id)) {
      if (t.taskName === 'apply') await this.eng.executeProcessTask(t.id, 'applicant', { submitType: APPLY })
    }
    const after = (await this.repo.findInstanceById(inst.id))!
    const rows = (await this.repo.findDoingTasks(after.id)).filter(t => t.taskName === 'review')
    return { inst: after, rows }
  }
}

describe('任务时限动作', () => {
  it('建单：autoExecute=Y 与 reminderTime 产出动作行，相对量锚定创建时刻', async () => {
    const h = new Harness({ expireTime: '2h', autoExecute: 'Y', reminderTime: '30m' })
    const { inst, rows } = await h.startReview()
    assert.equal(rows.length, 1)
    const review = rows[0]
    assert.equal(h.sink.ofType('AUTO_COMPLETE').length, 1)
    assert.equal(h.sink.ofType('REMIND').length, 1)
    const auto = h.sink.ofType('AUTO_COMPLETE')[0]
    const remind = h.sink.ofType('REMIND')[0]
    assert.equal(auto.idempotencyKey, `wf:auto:${review.id}:0`)
    assert.equal(remind.idempotencyKey, `wf:remind:${review.id}:1`)
    assert.equal(remind.occurrenceNo, 1)
    assert.equal(auto.taskId, review.id)
    assert.equal(auto.instanceId, inst.id)
    assert.equal(remind.dueAt, new Date('2026-11-19T09:30:00').getTime())
    assert.equal(auto.dueAt, new Date('2026-11-19T11:00:00').getTime())
  })

  it('未配置不插行', async () => {
    const h = new Harness({})
    await h.startReview()
    assert.equal(h.sink.actions.length, 0)
  })

  it('autoExecute 仅精确 Y', async () => {
    for (const v of ['N', 'n', 'y', 'true']) {
      const h = new Harness({ expireTime: '2h', autoExecute: v })
      await h.startReview()
      assert.equal(h.sink.ofType('AUTO_COMPLETE').length, 0, `autoExecute=${v} 不得开启`)
    }
  })

  it('严格 HH:mm：当天 / 已过则次日', async () => {
    const h = new Harness({ reminderTime: '12:00' })
    await h.startReview()
    assert.equal(h.sink.ofType('REMIND')[0].dueAt, new Date('2026-11-19T12:00:00').getTime())
    const h2 = new Harness({ reminderTime: '08:00' })
    await h2.startReview()
    assert.equal(h2.sink.ofType('REMIND')[0].dueAt, new Date('2026-11-20T08:00:00').getTime())
  })

  it('非法 reminderTime 不打断流程', async () => {
    const h = new Harness({ reminderTime: '2.5h' })
    const { rows } = await h.startReview()
    assert.equal(rows.length, 1)
    assert.equal(h.sink.ofType('REMIND').length, 0)
  })

  it('并行会签逐成员建行', async () => {
    const h = new Harness({ assignee: 'userA,userB', performType: 1, countersignType: 'PARALLEL', reminderTime: '1h' })
    const { rows } = await h.startReview()
    assert.equal(rows.length, 2)
    const ids = new Set(h.sink.ofType('REMIND').map(a => a.taskId))
    for (const r of rows) assert.ok(ids.has(r.id), `成员 ${r.id} 缺提醒行`)
  })

  it('串行会签推进出的下一位补建动作行', async () => {
    const h = new Harness({ assignee: 'userA,userB', performType: 1, countersignType: 'SEQUENTIAL', expireTime: '2h', autoExecute: 'Y' })
    const { inst, rows } = await h.startReview()
    const first = rows[0]
    assert.ok(h.sink.ofType('AUTO_COMPLETE').some(a => a.taskId === first.id))
    await h.eng.executeProcessTask(first.id, 'userA', { submitType: AGREE })
    const after = (await h.repo.findInstanceById(inst.id))!
    const nxt = (await this_doing(h.repo, after.id, 'review')).filter(t => t.id !== first.id)
    assert.equal(nxt.length, 1)
    assert.ok(h.sink.ofType('AUTO_COMPLETE').some(a => a.taskId === nxt[0].id))
    assert.ok(h.sink.cancelledTasks.includes(first.id))
  })

  it('协办行不继承时限动作', async () => {
    const h = new Harness({ expireTime: '2h', autoExecute: 'Y', reminderTime: '1h' })
    const { rows } = await h.startReview()
    const before = h.sink.actions.length
    await h.eng.aidantTask(rows[0].id, ['aid1'], '', false, 'userA')
    assert.equal(h.sink.actions.length, before)
  })

  it('回调只在 TASK_COMPLETE 事实触发', async () => {
    const h = new Harness({ callback: 'demoHandler', reminderTime: '1h' })
    const { rows } = await h.startReview()
    await h.eng.executeProcessTask(rows[0].id, 'userA', { submitType: AGREE })
    const cbs = h.sink.ofType('CALLBACK')
    assert.equal(cbs.length, 1)
    assert.equal(cbs[0].idempotencyKey, `wf:callback:${rows[0].id}:0`)
    assert.ok(h.sink.cancelledTasks.includes(rows[0].id))

    const h2 = new Harness({ callback: 'demoHandler' })
    const r2 = await h2.startReview()
    await h2.eng.executeAndJumpToEnd(r2.rows[0].id, 'userA', { submitType: REJECT })
    assert.equal(h2.sink.ofType('CALLBACK').length, 0)
  })

  it('实例终态取消实例动作行', async () => {
    const h = new Harness({ reminderTime: '1h' })
    const { inst, rows } = await h.startReview()
    await h.eng.executeProcessTask(rows[0].id, 'userA', { submitType: AGREE })
    assert.ok(h.sink.cancelledInstances.includes(inst.id))
  })

  it('实例级排他锁调用面', async () => {
    const h = new Harness({})
    const { inst, rows } = await h.startReview()
    await h.eng.executeProcessTask(rows[0].id, 'userA', { submitType: AGREE })
    assert.ok(h.repo.locked.includes(inst.id))
  })

  it('firstReminderTime 档位自证', () => {
    const base = new Date('2026-11-19T09:00:00')
    assert.equal(firstReminderTime('30m', {}, base)!.getTime(), new Date('2026-11-19T09:30:00').getTime())
    assert.equal(firstReminderTime('dueAt', { dueAt: '2026-12-31 10:00:00' }, base)!.getTime(),
      new Date('2026-12-31T10:00:00').getTime())
    assert.equal(firstReminderTime('2.5h', {}, base), null)
  })
})

async function this_doing(repo: MemoryRepository, instId: string, name: string) {
  return (await repo.findDoingTasks(instId)).filter(t => t.taskName === name)
}
