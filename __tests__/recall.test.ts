/**
 * 「已办撤回（allowRecall）」验收（Node 栈，issues/246）——移植基准＝jeeflow-java
 * `core/RecallSupport.java` ＋ `JeeflowEngineImpl.recallTask`（含 14674d7 补的"复活行 fire 码 3"
 * 那一腿）＋ `domain/ProcessInstance.recallTask`，交叉样本＝go `engine/recall.go`（v1.8.61）与
 * python `jeeflow/recall.py`（1.8.57）。
 *
 * 覆盖：正向复活三件套（含**码 3 恰一次**＋**码 10 恰一次**＋不补发 5/6）、窗口拦＋零写入、
 * 开关未开、非参与者、flow.admin/flow.auto 放行、非 FINISHED 行、实例非 DOING、后加签行连带废弃、
 * 并行分支双废弃、重办链上二次撤回、两枚参数档、两条解析期禁配、逐字文案常量自证。
 *
 * 夹具走内联 JSON（{@link chain}），不碰共享 `flows/` 目录——与 add-sign-after.test.ts 同策：
 * 共享流程 JSON 的镜像与漂移门禁是另一条腿，不在这里加文件把它拖进十仓同步。
 */
import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { EngineImpl, KeySubmitType } from '../src/engine.js'
import { JeeflowFacade } from '../src/facade.js'
import { KeyAddSignOperators, checkFlowConfig } from '../src/addsign.js'
import {
  KeyRecallHistory, MSG_INSTANCE_NOT_DOING, MSG_NO_PERMISSION, MSG_NOT_FINISHED,
  PROP_ALLOW_RECALL, msgRecallCountersignForbid, msgRecallFirstTaskForbid,
  msgSwitchOff, msgWindow, recallHistoryOf,
} from '../src/recall.js'
import { MemoryRepository } from '../src/memory.js'
import {
  InstanceState, SubmitType, TaskState,
  type ProcessDefine, type ProcessTask,
} from '../src/model.js'
import { EventType, type ProcessEvent } from '../src/extensions.js'
import type { ExpressionEvaluator, UserProvider } from '../src/spi.js'

const AGREE = SubmitType.Agree
const APPLY = SubmitType.Apply
const REJECT = SubmitType.Reject

function setup() {
  const repo = new MemoryRepository()
  const userProv: UserProvider = {
    async getUser(userId: string) {
      return { userId, realName: '用户' + userId, deptId: 'D01', deptName: '测试部门', postId: 'P01', postName: '测试岗位' }
    },
  }
  // id 发生器用单调计数器（同 add-sign-after.test.ts 的教训：同毫秒自撞会让血缘/待办凭空消失）
  const base = Date.now() * 1000
  let n = 0
  const idGen = { nextId() { n += 1; return String(base + n) } }
  const exprEval: ExpressionEvaluator = { async eval() { return false } }
  const engine = new EngineImpl(repo, userProv, idGen as any, exprEval)
  const fired: ProcessEvent[] = []
  engine.setExtensions({ listeners: [(e) => { fired.push({ ...e }) }] })
  return { engine, repo, fired, facade: new JeeflowFacade(engine, repo) }
}

// ─── 夹具 ─────────────────────────────────────────────────────────────────────

const nodeOf = (id: string, type: string, props: Record<string, any>, text: string) =>
  ({ id, type, x: 0, y: 0, properties: props, text: { value: text } })
const edgeOf = (id: string, from: string, to: string) =>
  ({ id, type: 'snaker:transition', sourceNodeId: from, targetNodeId: to, properties: {} })

let seq = 0
/**
 * start → apply → review → final → archive → end。
 * 末端多挂一个 archive 待办：撤回的窗口判据要"实例仍进行中"才照得出来——三节点的夹具里
 * 终审一办结实例就进 20，那档会被实例状态守卫先拦下，窗口那一格就废了。
 */
function chain(applyProps: Record<string, any>, reviewProps: Record<string, any>): string {
  return JSON.stringify({
    name: `recall-${++seq}`, displayName: '已办撤回夹具', type: 'approval',
    nodes: [
      nodeOf('start', 'snaker:start', {}, '开始'),
      nodeOf('apply', 'snaker:task', { form: 'apply-form', assignee: 'applicant', taskType: 0, performType: 0, ...applyProps }, '发起申请'),
      nodeOf('review', 'snaker:task', { form: 'form-r', assignee: 'userA', taskType: 0, performType: 0, ...reviewProps }, '审批'),
      nodeOf('final', 'snaker:task', { form: 'form-f', assignee: 'userF', taskType: 0, performType: 0 }, '终审'),
      nodeOf('archive', 'snaker:task', { form: 'form-a', assignee: 'userG', taskType: 0, performType: 0 }, '归档'),
      nodeOf('end', 'snaker:end', {}, '结束'),
    ],
    edges: [edgeOf('e1', 'start', 'apply'), edgeOf('e2', 'apply', 'review'),
      edgeOf('e3', 'review', 'final'), edgeOf('e4', 'final', 'archive'),
      edgeOf('e5', 'archive', 'end')],
  })
}

/** start → apply → review → fork → (left / right) → join → end：撤回后并行两支都要废弃那一档用。 */
function forkChain(reviewProps: Record<string, any>): string {
  return JSON.stringify({
    name: `recall-fork-${++seq}`, displayName: '已办撤回并行夹具', type: 'approval',
    nodes: [
      nodeOf('start', 'snaker:start', {}, '开始'),
      nodeOf('apply', 'snaker:task', { form: 'apply-form', assignee: 'applicant', taskType: 0, performType: 0 }, '发起申请'),
      nodeOf('review', 'snaker:task', { form: 'form-r', assignee: 'userA', taskType: 0, performType: 0, ...reviewProps }, '审批'),
      nodeOf('fork', 'snaker:fork', {}, '并行分叉'),
      nodeOf('left', 'snaker:task', { form: 'form-l', assignee: 'userL', taskType: 0, performType: 0 }, '左支'),
      nodeOf('right', 'snaker:task', { form: 'form-rt', assignee: 'userR', taskType: 0, performType: 0 }, '右支'),
      nodeOf('join', 'snaker:join', {}, '并行汇合'),
      nodeOf('end', 'snaker:end', {}, '结束'),
    ],
    edges: [
      edgeOf('e1', 'start', 'apply'), edgeOf('e2', 'apply', 'review'), edgeOf('e3', 'review', 'fork'),
      edgeOf('e4', 'fork', 'left'), edgeOf('e5', 'fork', 'right'),
      edgeOf('e6', 'left', 'join'), edgeOf('e7', 'right', 'join'), edgeOf('e8', 'join', 'end'),
    ],
  })
}

const RECALL_ON = { allowRecall: true }

function registerFlowJson(repo: MemoryRepository, jsonStr: string): ProcessDefine {
  const raw = JSON.parse(jsonStr)
  const def: ProcessDefine = {
    id: '', name: raw.name, displayName: raw.displayName ?? '已办撤回夹具', type: raw.type ?? 'approval',
    state: 1, content: jsonStr, version: 1,
  } as ProcessDefine
  repo.addDefine(def)
  return def
}

/** 发起并办结申请节点，返回停在 review 的实例；参数是审批节点的 properties 片段。 */
async function startToReview(repo: MemoryRepository, engine: any, reviewProps: Record<string, any>, jsonStr?: string) {
  const def = registerFlowJson(repo, jsonStr ?? chain({}, reviewProps))
  const started = await engine.startProcessInstanceById(def.id, 'applicant', {})
  for (const t of await repo.findDoingTasks(started.id)) {
    await engine.executeProcessTask(t.id, 'applicant', { [KeySubmitType]: APPLY })
  }
  return (await repo.findInstanceById(started.id))!
}

const doing = async (repo: MemoryRepository, iid: string, name: string) =>
  (await repo.findDoingTasks(iid)).find(t => t.taskName === name)
const doingCount = async (repo: MemoryRepository, iid: string, name: string) =>
  (await repo.findDoingTasks(iid)).filter(t => t.taskName === name).length
const rowOf = async (repo: MemoryRepository, iid: string, name: string) =>
  (await repo.findHistoryTasks(iid)).filter(t => t.taskName === name)
const plain = (submitType: number): Record<string, any> => ({ [KeySubmitType]: submitType })
const countType = (fired: ProcessEvent[], type: EventType) => fired.filter(e => e.type === type).length

/** 报错即零写入的四件核对：原行仍 DONE、实例状态保持原样、本节点行数不变。 */
async function assertNoRecallWrite(repo: MemoryRepository, target: ProcessTask, iid: string,
                                    before: number, instState: InstanceState = InstanceState.Doing) {
  const row = (await repo.findTaskById(target.id))!
  assert.equal(row.taskState, TaskState.Done, '报错时原行不得被改写')
  assert.equal((await repo.findInstanceById(iid))!.state, instState, '实例状态不得被动')
  assert.equal((await rowOf(repo, iid, target.taskName)).length, before, '报错时不得新增/废弃任何行')
}

describe('已办撤回（allowRecall）（Node）', () => {
  // ═══ 正向 ═══

  it('01 复活三件套：下游 DOING 废弃＋原行不改写只盖账本＋同节点新行；码 3 恰一次、码 10 恰一次、不补发 5/6', async () => {
    const { engine, repo, fired } = setup()
    const inst = await startToReview(repo, engine, { ...RECALL_ON, expireTime: '2h' })
    const old = (await doing(repo, inst.id, 'review'))!
    assert.ok(old, '应停在审批节点')
    await engine.executeProcessTask(old.id, 'userA', plain(AGREE))
    const fin = (await doing(repo, inst.id, 'final'))!
    assert.ok(fin, '办结后应流转到终审')
    const oldRow = (await repo.findTaskById(old.id))!
    assert.equal(oldRow.parentTaskId, (await repo.findHistoryTasks(inst.id)).find(t => t.taskName === 'apply')!.id,
      '原行的血缘 parent＝申请那一条')
    const applyParent = oldRow.parentTaskId!
    const beforeRows = (await rowOf(repo, inst.id, 'review')).length

    fired.length = 0
    const res = await engine.recallTask(old.id, 'userA')
    // ── 三件套之一：下游 DOING 行全部废弃 ──
    const abandonedFin = (await repo.findTaskById(fin.id))!
    assert.equal(abandonedFin.taskState, TaskState.Abandoned, '下游 DOING 行应被废弃(99)')
    assert.equal(abandonedFin.updateUser, 'userA', '废弃行的 update_user 记真实撤回人（java abandon(operator) 同尺）')
    // ── 三件套之二：原 FINISHED 行不改写，只盖 tf_recallHistory ──
    const keep = (await repo.findTaskById(old.id))!
    assert.equal(keep.taskState, TaskState.Done, '原行必须仍是已完成（历史即审批记录，不许翻回 DOING）')
    assert.equal(keep.actorId, 'userA', '原行办结人不动')
    assert.ok(keep.finishTime, '原行办结时刻不动')
    const hist = recallHistoryOf(keep)
    assert.equal(hist.length, 1, '账本恰一条')
    assert.deepEqual(Object.keys(hist[0]), ['operator', 'time', 'recalledTaskId'], '三键固定顺序与命名')
    assert.equal(hist[0].operator, 'userA')
    assert.equal(String(hist[0].recalledTaskId), String(res.id), 'recalledTaskId 指向复活行')
    assert.match(String(hist[0].time), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, 'time 是全生态格式串（§2.4）')
    // ── 三件套之三：同节点新建 DOING 行 ──
    assert.equal(res.taskState, TaskState.Doing, '复活行是唯一活待办')
    assert.equal(res.taskName, 'review')
    assert.equal(res.displayName, '审批', 'displayName 继承原行')
    assert.equal(res.formKey, 'form-r', 'formKey 继承节点配置')
    assert.equal(res.performType, 0, '复活行是普通任务行')
    assert.equal(res.parentTaskId, applyParent, 'parent＝原行 parent（不是原行 id）')
    assert.deepEqual(res.actorIds, ['userA'], '参与者＝原行名册')
    assert.ok(res.expireTime instanceof Date, 'expire_time 同尺重算（节点配了 2h）')
    assert.equal(await doingCount(repo, inst.id, 'review'), 1, '本节点只应有一条待办')
    assert.equal(await doing(repo, inst.id, 'final'), undefined, '终审待办不得还活着')
    assert.equal((await rowOf(repo, inst.id, 'review')).length, beforeRows + 1)
    const instRow = (await repo.findInstanceById(inst.id))!
    assert.equal(instRow.state, InstanceState.Doing)
    assert.equal(instRow.updateUser, 'userA', '实例 update_user 记撤回人')
    // ── 事件：码 3 恰一次（复活行走既有建单腿）＋码 10 恰一次＋不补发 5/6 ──
    assert.equal(countType(fired, EventType.ProcessTaskStart), 1, '码 3 恰一次（复活行）')
    const start = fired.find(e => e.type === EventType.ProcessTaskStart)!
    assert.equal(String(start.taskId), String(res.id))
    assert.equal(start.instanceId, inst.id)
    assert.deepEqual(start.actors, ['userA'])
    assert.equal(countType(fired, EventType.TaskRecall), 1, '码 10 恰一次')
    const rc = fired.find(e => e.type === EventType.TaskRecall)!
    assert.equal(String(rc.taskId), String(old.id), '码 10 的 sourceId＝被撤的旧行')
    assert.equal(rc.instanceId, inst.id)
    assert.equal(rc.operator, 'userA')
    assert.equal(countType(fired, EventType.TaskComplete), 0, '只发 10，不补发 5')
    assert.equal(countType(fired, EventType.TaskReject), 0, '只发 10，不补发 6')
    assert.equal(countType(fired, EventType.ProcessInstanceEnd), 0, '撤回不是实例终态')
  })

  it('02 多人名册：复活行参与者＝原行整份名册（不是末跳办理人）', async () => {
    const { engine, repo } = setup()
    const inst = await startToReview(repo, engine, { ...RECALL_ON, assignee: 'userA,userB' })
    const old = (await doing(repo, inst.id, 'review'))!
    assert.deepEqual(old.actorIds, ['userA', 'userB'])
    await engine.executeProcessTask(old.id, 'userA', plain(AGREE))
    const res = await engine.recallTask(old.id, 'userB')   // 名册内另一位有权撤
    assert.deepEqual(res.actorIds, ['userA', 'userB'], '名册整份继承')
  })

  it('03 撤回后重办＝普通 execute；重办行再撤一次 ⇒ 两行各留一条账本、活待办仍只有一条', async () => {
    const { engine, repo } = setup()
    const inst = await startToReview(repo, engine, RECALL_ON)
    const a = (await doing(repo, inst.id, 'review'))!
    await engine.executeProcessTask(a.id, 'userA', plain(AGREE))
    const b = await engine.recallTask(a.id, 'userA')
    assert.equal(b.taskState, TaskState.Doing)
    // 重办（新行正常办理）→ 又办结 → 再撤一次
    await engine.executeProcessTask(b.id, 'userA', plain(AGREE))
    assert.ok(await doing(repo, inst.id, 'final'))
    const c = await engine.recallTask(b.id, 'userA')
    assert.notEqual(String(c.id), String(b.id))
    assert.equal(recallHistoryOf((await repo.findTaskById(a.id))!).length, 1, '第一行的账本不动')
    assert.equal(recallHistoryOf((await repo.findTaskById(b.id))!).length, 1, '第二行盖上自己那一条')
    assert.equal(String((recallHistoryOf((await repo.findTaskById(b.id))!)[0]).recalledTaskId), String(c.id))
    assert.equal(await doingCount(repo, inst.id, 'review'), 1, '活待办只有一条')
    assert.equal((await repo.findTaskById(c.id))!.taskState, TaskState.Doing)
    assert.equal((await rowOf(repo, inst.id, 'final')).length, 2, 'final 建过两次、两次都被撤回清场')
    assert.ok((await rowOf(repo, inst.id, 'final')).every(t => t.taskState === TaskState.Abandoned),
      '两条 final 行都是废弃态（复活行的下游同样被覆盖）')
  })

  // ═══ 负向：五条逐字文案，全部报错即零写入 ═══

  it('04 窗口拦（宽口径）：下游存在任何 FINISHED ⇒ 逐字报错＋零写入', async () => {
    const { engine, repo, fired } = setup()
    const inst = await startToReview(repo, engine, RECALL_ON)
    const review = (await doing(repo, inst.id, 'review'))!
    await engine.executeProcessTask(review.id, 'userA', plain(AGREE))
    const fin = (await doing(repo, inst.id, 'final'))!
    await engine.executeProcessTask(fin.id, 'userF', plain(AGREE))
    assert.ok(await doing(repo, inst.id, 'archive'), '前置：实例仍进行中、归档那条还待办')
    fired.length = 0
    const before = (await rowOf(repo, inst.id, 'review')).length
    await assert.rejects(() => engine.recallTask(review.id, 'userA'),
      (e: Error) => { assert.equal(e.message, msgWindow('review')); return true })
    await assertNoRecallWrite(repo, review, inst.id, before)
    assert.equal((await repo.findTaskById(fin.id))!.taskState, TaskState.Done, '已办结的下游行不得被废弃')
    assert.equal((await repo.findTaskById((await doing(repo, inst.id, 'archive'))!.id))!.taskState,
      TaskState.Doing, '报错那次在办的归档行也不得被动')
    assert.equal(fired.length, 0, '报错那次零事件')
  })

  it('05 节点未开 allowRecall ⇒ 逐字报错＋零写入', async () => {
    const { engine, repo } = setup()
    const inst = await startToReview(repo, engine, {})   // review 不开 allowRecall
    const review = (await doing(repo, inst.id, 'review'))!
    await engine.executeProcessTask(review.id, 'userA', plain(AGREE))
    const before = (await rowOf(repo, inst.id, 'review')).length
    await assert.rejects(() => engine.recallTask(review.id, 'userA'),
      (e: Error) => { assert.equal(e.message, msgSwitchOff('review')); return true })
    await assertNoRecallWrite(repo, review, inst.id, before)
  })

  it('06 非参与者 ⇒ 无权限撤回该任务＋零写入（名册判据，不走只认 DOING 的 isAllowed）', async () => {
    const { engine, repo } = setup()
    const inst = await startToReview(repo, engine, RECALL_ON)
    const review = (await doing(repo, inst.id, 'review'))!
    await engine.executeProcessTask(review.id, 'userA', plain(AGREE))
    const before = (await rowOf(repo, inst.id, 'review')).length
    await assert.rejects(() => engine.recallTask(review.id, 'userZ'),
      (e: Error) => { assert.equal(e.message, MSG_NO_PERMISSION); return true })
    await assertNoRecallWrite(repo, review, inst.id, before)
  })

  it('07 特权放行：flow.admin / flow.auto 不在名册也能撤', async () => {
    for (const op of ['flow.admin', 'FLOW.AUTO']) {
      const { engine, repo } = setup()
      const inst = await startToReview(repo, engine, RECALL_ON)
      const review = (await doing(repo, inst.id, 'review'))!
      await engine.executeProcessTask(review.id, 'userA', plain(AGREE))
      const res = await engine.recallTask(review.id, op)
      assert.equal(res.taskState, TaskState.Doing, `${op} 应放行`)
      assert.equal(recallHistoryOf((await repo.findTaskById(review.id))!)[0].operator, op,
        '账本记的是实际执行人')
    }
  })

  it('08 目标行非 FINISHED ⇒ 任务非已完成状态，不可撤回（DOING 与不存在的行同档）', async () => {
    const { engine, repo } = setup()
    const inst = await startToReview(repo, engine, RECALL_ON)
    const review = (await doing(repo, inst.id, 'review'))!
    await assert.rejects(() => engine.recallTask(review.id, 'userA'),
      (e: Error) => { assert.equal(e.message, MSG_NOT_FINISHED); return true })
    assert.equal((await repo.findTaskById(review.id))!.taskState, TaskState.Doing, '报错那次零写入')
    // 不存在的行同档
    await assert.rejects(() => engine.recallTask('999999999', 'userA'),
      (e: Error) => { assert.equal(e.message, MSG_NOT_FINISHED); return true })
    // 被废弃(99)的行同档（撤回清场后不得再撤那一手）
    await engine.executeProcessTask(review.id, 'userA', plain(AGREE))
    const fin = (await doing(repo, inst.id, 'final'))!
    await engine.recallTask(review.id, 'userA')
    assert.equal((await repo.findTaskById(fin.id))!.taskState, TaskState.Abandoned, '前置：下游行已废弃')
    await assert.rejects(() => engine.recallTask(fin.id, 'userF'),
      (e: Error) => { assert.equal(e.message, MSG_NOT_FINISHED); return true }, '废弃行不是已完成行')
  })

  it('09 实例非 DOING ⇒ 流程实例非进行中状态，不可撤回＋零写入', async () => {
    const { engine, repo } = setup()
    const inst = await startToReview(repo, engine, RECALL_ON)
    const review = (await doing(repo, inst.id, 'review'))!
    await engine.executeProcessTask(review.id, 'userA', plain(AGREE))
    await engine.executeProcessTask((await doing(repo, inst.id, 'final'))!.id, 'userF', plain(AGREE))
    await engine.executeProcessTask((await doing(repo, inst.id, 'archive'))!.id, 'userG', plain(AGREE))
    const done = (await repo.findInstanceById(inst.id))!
    assert.equal(done.state, InstanceState.Done, '前置：实例已办结(20)')
    const before = (await rowOf(repo, inst.id, 'review')).length
    await assert.rejects(() => engine.recallTask(review.id, 'userA'),
      (e: Error) => { assert.equal(e.message, MSG_INSTANCE_NOT_DOING); return true })
    await assertNoRecallWrite(repo, review, inst.id, before, InstanceState.Done)
    assert.equal((await repo.findInstanceById(inst.id))!.state, InstanceState.Done, '实例终态不得被改回')
  })

  // ═══ 连带废弃面 ═══

  it('10 后加签行属下游 DOING ⇒ 撤回时自然覆盖（不留孤儿待办）', async () => {
    const { engine, repo } = setup()
    const inst = await startToReview(repo, engine, { ...RECALL_ON, allowAddSign: true })
    const a = (await doing(repo, inst.id, 'review'))!
    // A 办结时把会签加给 B（后加签行 parent＝A）
    await engine.executeProcessTask(a.id, 'userA', { [KeySubmitType]: AGREE, [KeyAddSignOperators]: 'userB' })
    const b = (await doing(repo, inst.id, 'review'))!
    assert.equal(b.parentTaskId, a.id)
    await assert.rejects(() => engine.recallTask(b.id, 'userB'),
      (e: Error) => { assert.equal(e.message, MSG_NOT_FINISHED); return true }, 'B 那条还是 DOING，撤不动')
    // 撤 A：B 是 A 的下游 DOING ⇒ 连带废弃
    const res = await engine.recallTask(a.id, 'userA')
    assert.equal((await repo.findTaskById(b.id))!.taskState, TaskState.Abandoned, '后加签行连带废弃')
    assert.equal(await doingCount(repo, inst.id, 'review'), 1, '活待办只剩复活那一行')
    assert.equal(String(res.id), String((await doing(repo, inst.id, 'review'))!.id))
  })

  it('11 并行分支：该行办结触发的多支下游 DOING 全部废弃；任一支已办结 ⇒ 窗口拦', async () => {
    const { engine, repo } = setup()
    const inst = await startToReview(repo, engine, RECALL_ON, forkChain(RECALL_ON))
    const review = (await doing(repo, inst.id, 'review'))!
    await engine.executeProcessTask(review.id, 'userA', plain(AGREE))
    const left = (await doing(repo, inst.id, 'left'))!
    const right = (await doing(repo, inst.id, 'right'))!
    assert.ok(left && right, '前置：并行两支都应有待办')

    await engine.executeProcessTask(left.id, 'userL', plain(AGREE))
    const before = (await rowOf(repo, inst.id, 'review')).length
    await assert.rejects(() => engine.recallTask(review.id, 'userA'),
      (e: Error) => { assert.equal(e.message, msgWindow('review')); return true }, '一支已办结 ⇒ 拦')
    await assertNoRecallWrite(repo, review, inst.id, before)
    assert.equal((await repo.findTaskById(right.id))!.taskState, TaskState.Doing, '报错那次另一支不得被动')
  })

  it('11b 并行分支双废弃（两支都还 DOING）', async () => {
    const { engine, repo } = setup()
    const inst = await startToReview(repo, engine, RECALL_ON, forkChain(RECALL_ON))
    const review = (await doing(repo, inst.id, 'review'))!
    await engine.executeProcessTask(review.id, 'userA', plain(AGREE))
    const left = (await doing(repo, inst.id, 'left'))!
    const right = (await doing(repo, inst.id, 'right'))!
    const res = await engine.recallTask(review.id, 'userA')
    assert.equal((await repo.findTaskById(left.id))!.taskState, TaskState.Abandoned)
    assert.equal((await repo.findTaskById(right.id))!.taskState, TaskState.Abandoned)
    assert.equal(await doingCount(repo, inst.id, 'left'), 0)
    assert.equal(await doingCount(repo, inst.id, 'right'), 0)
    assert.equal(String(res.taskName), 'review')
    assert.equal(res.parentTaskId, review.parentTaskId, '复活行血缘接回原行的 parent')
    // 已废弃(99)的分支行既不拦（上面已撤成）也不可再撤
    await assert.rejects(() => engine.recallTask(left.id, 'userL'),
      (e: Error) => { assert.equal(e.message, MSG_NOT_FINISHED); return true })
  })

  // ═══ 门面 action 与参数档 ═══

  it('12 门面 action processTask/recall：成功信封带 processTaskId/taskState；参数两档逐字报错', async () => {
    const { engine, repo, facade } = setup()
    const inst = await startToReview(repo, engine, RECALL_ON)
    const review = (await doing(repo, inst.id, 'review'))!
    await engine.executeProcessTask(review.id, 'userA', plain(AGREE))

    const noOp = await facade.flow('processTask/recall', { processTaskId: review.id, operator: '  ' })
    assert.equal(noOp.code, 99999999, JSON.stringify(noOp))
    assert.equal(noOp.msg, 'operator 必填', 'operator 硬必填（与 transfer/withdraw 同口径）')

    const noId = await facade.flow('processTask/recall', { operator: 'userA' })
    assert.equal(noId.code, 99999999, JSON.stringify(noId))
    assert.match(String(noId.msg), /id 缺失或非法/, '主键档缺失响亮报错，绝不拿 \'\'/0 落库')

    const before = (await rowOf(repo, inst.id, 'review')).length
    assert.equal(noOp.code, 99999999)
    await assertNoRecallWrite(repo, review, inst.id, before)

    const ok = await facade.flow('processTask/recall', { processTaskId: review.id, operator: 'userA' })
    assert.equal(ok.code, 0, JSON.stringify(ok))
    assert.equal(Number(ok.data.taskState), TaskState.Doing)
    assert.equal(String(ok.data.processTaskId), String((await doing(repo, inst.id, 'review'))!.id))
  })

  it('13 失败信封带逐字 msg（不被出口固定文案兜底吞掉）', async () => {
    const { engine, repo, facade } = setup()
    const inst = await startToReview(repo, engine, RECALL_ON)
    const review = (await doing(repo, inst.id, 'review'))!
    await engine.executeProcessTask(review.id, 'userA', plain(AGREE))
    await engine.executeProcessTask((await doing(repo, inst.id, 'final'))!.id, 'userF', plain(AGREE))
    const res = await facade.flow('processTask/recall', { processTaskId: review.id, operator: 'userA' })
    assert.equal(res.code, 99999999, JSON.stringify(res))
    assert.equal(res.msg, msgWindow('review'), '引擎中文契约文案必须逐字透出')
  })

  it('14 撤回后重办并办结：实例正常走完（历史行齐、审批记录可呈现完整链）', async () => {
    const { engine, repo } = setup()
    const inst = await startToReview(repo, engine, RECALL_ON)
    const a = (await doing(repo, inst.id, 'review'))!
    await engine.executeProcessTask(a.id, 'userA', plain(AGREE))
    const b = await engine.recallTask(a.id, 'userA')
    assert.equal(b.taskState, TaskState.Doing, '撤回后本节点的活待办就是复活行')
    // 重办＝普通 execute（不为撤回另开一条通道），之后照常走到实例办结
    await engine.executeProcessTask(b.id, 'userA', plain(AGREE))
    for (const name of ['final', 'archive']) {
      const t = (await doing(repo, inst.id, name))!
      assert.ok(t, `前置：应走到 ${name}`)
      await engine.executeProcessTask(t.id, (t.actorIds[0] ?? '') as string, plain(AGREE))
    }
    assert.equal((await repo.findInstanceById(inst.id))!.state, InstanceState.Done, '实例办结')
    const rows = await rowOf(repo, inst.id, 'review')
    assert.equal(rows.length, 2, '一条历史行＋一条复活重办行')
    assert.ok(rows.every(r => r.taskState === TaskState.Done), '两行都是已完成态（原行不改写）')
  })

  // ═══ 解析期两条禁配 ＋ 非法值 ═══

  it('15 会签节点配 allowRecall ⇒ 解析期逐字报错', () => {
    const bad = JSON.parse(chain({}, { ...RECALL_ON, performType: 1, countersignType: 'PARALLEL' }))
    assert.throws(() => checkFlowConfig(bad),
      (e: Error) => { assert.equal(e.message, msgRecallCountersignForbid('review')); return true })
    assert.throws(() => checkFlowConfig(bad), /会签节点\[review\]不允许配置 allowRecall/)
  })

  it('16 首任务节点（申请节点）配 allowRecall ⇒ 解析期逐字报错', () => {
    const bad = JSON.parse(chain(RECALL_ON, RECALL_ON))
    assert.throws(() => checkFlowConfig(bad),
      (e: Error) => { assert.equal(e.message, msgRecallFirstTaskForbid('apply')); return true })
    assert.throws(() => checkFlowConfig(bad), /首任务节点\[apply\]不允许配置 allowRecall/)
  })

  it('17 allowRecall 非法值 ⇒ 解析期报错，不得静默当缺省', () => {
    assert.throws(() => checkFlowConfig(JSON.parse(chain({}, { allowRecall: 'yes' }))),
      /节点\[review\]的 allowRecall 配置非法: yes/)
    // 合法形状不得误伤
    checkFlowConfig(JSON.parse(chain({}, { allowRecall: 'true' })))
    checkFlowConfig(JSON.parse(chain({}, { allowRecall: false })))
  })

  it('18 解析期校验已接进读定义的口子与发布腿：带病定义发起即拒／deploy 即拒', async () => {
    const { engine, repo, facade } = setup()
    const def = registerFlowJson(repo, chain({}, { ...RECALL_ON, performType: 1 }))
    await assert.rejects(() => engine.startProcessInstanceById(def.id, 'applicant', {}),
      /会签节点\[review\]不允许配置 allowRecall/)
    const bad = await facade.flow('processDefine/deploy',
      { content: chain(RECALL_ON, RECALL_ON), operator: 'admin' })
    assert.equal(bad.code, 99999999, JSON.stringify(bad))
    assert.match(String(bad.msg), /首任务节点\[apply\]不允许配置 allowRecall/)
    const good = await facade.flow('processDefine/deploy', { content: chain({}, RECALL_ON), operator: 'admin' })
    assert.equal(good.code, 0, JSON.stringify(good))
  })

  // ═══ 逐字文案常量自证（钉子：跨栈契约串不许漂） ═══

  it('19 文案与键名常量自证', () => {
    assert.equal(PROP_ALLOW_RECALL, 'allowRecall')
    assert.equal(KeyRecallHistory, 'tf_recallHistory')
    assert.equal(MSG_NOT_FINISHED, '任务非已完成状态，不可撤回')
    assert.equal(MSG_NO_PERMISSION, '无权限撤回该任务')
    assert.equal(MSG_INSTANCE_NOT_DOING, '流程实例非进行中状态，不可撤回')
    assert.equal(msgWindow('n1'), '任务[n1]的后续节点已办理，不能撤回')
    assert.equal(msgSwitchOff('n1'), '节点[n1]未开启 allowRecall，不能撤回')
    assert.equal(msgRecallCountersignForbid('n1'), '会签节点[n1]不允许配置 allowRecall：撤"谁的一票"语义不清')
    assert.equal(msgRecallFirstTaskForbid('n1'),
      '首任务节点[n1]不允许配置 allowRecall：申请节点走实例撤回＋重新发起，不需要同实例复活')
    assert.equal(EventType.TaskRecall, 10, '码 10＝TASK_RECALL（规范 11 §11.3）')
    assert.equal(EventType[10], 'TaskRecall', '反向映射出的是规范成员名')
  })

  it('20 业务变量不回滚（承诺边界）：f_ 已进实例变量，撤回只撤"推进"', async () => {
    const { engine, repo } = setup()
    const inst = await startToReview(repo, engine, RECALL_ON)
    const review = (await doing(repo, inst.id, 'review'))!
    await engine.executeProcessTask(review.id, 'userA', { [KeySubmitType]: AGREE, f_amount: 880 })
    await engine.recallTask(review.id, 'userA')
    const after = (await repo.findInstanceById(inst.id))!
    assert.equal(after.variables.f_amount, 880, 'f_ 表单字段留在实例变量里（不随撤回回滚）')
  })
})
