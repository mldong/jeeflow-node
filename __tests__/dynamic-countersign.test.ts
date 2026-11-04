/**
 * 「动态会签（征询模式 dynamicCountersign）」验收（Node 栈，issues/247）——移植基准＝
 * jeeflow-java `core/CollectSupport.java` ＋ `facade/JeeflowFacade` 的
 * tryDynamicCountersign／gateDynamicCountersign／taskRevokeCountersign ＋ `model/TaskModel.exec`
 * 第三档；交叉样本＝go `engine/collect.go`＋`facade/collect.go`（v1.8.61）与
 * python `jeeflow/collect.py`＋`facade.py`（1.8.57）。
 *
 * 覆盖：发起不办结＋marker＋成员行三戳、闸门逐字文案（AGREE 与 REJECT 都挡）、成员拉人禁、
 * 重复/给自己/非参与人/互斥/上限、征询档推进闸（主办 DOING⇒不流转；收齐后拍板才流出）、
 * 撤回恢复闸门＋已交意见保留＋二次撤回逐字文案＋轮次不消耗、多轮跨轮计数、投影 active 翻转
 * （跳过 99）、废弃腿扩双开关、三条解析期禁配、参数两档、逐字文案常量自证。
 *
 * 夹具走内联 JSON（{@link chain}），不碰共享 `flows/` 目录（同 add-sign-after.test.ts 的纪律）。
 */
import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { EngineImpl, KeySubmitType } from '../src/engine.js'
import { JeeflowFacade } from '../src/facade.js'
import {
  AddSignRoundKey, KeyAddSignHistory, KeyAddSignOperators, MSG_MUTEX, MSG_SELF,
  checkFlowConfig, historyOf,
} from '../src/addsign.js'
import {
  KeyAddSignReason, MSG_MEMBER_PULL, MSG_NO_PERMISSION_REVOKE, MSG_NOT_ALLOWED_EXECUTE,
  PROP_DYNAMIC_COUNTERSIGN, buildProjection, memberCounts, msgCollectApplyForbid,
  msgCollectCountersignForbid, msgDuplicate, msgMutexWithAddSign, msgNoPending, msgPending,
} from '../src/collect.js'
import { MemoryRepository } from '../src/memory.js'
import {
  InstanceState, SubmitType, TaskState,
  type ProcessDefine, type ProcessTask,
} from '../src/model.js'
import { EventType, type ProcessEvent } from '../src/extensions.js'
import type { ExpressionEvaluator, UserProvider } from '../src/spi.js'

const AGREE = SubmitType.Agree
const REJECT = SubmitType.Reject
const APPLY = SubmitType.Apply
const ROUND_KEY = `${AddSignRoundKey}_review`
const DC_ON = { dynamicCountersign: true }

function setup() {
  const repo = new MemoryRepository()
  const userProv: UserProvider = {
    async getUser(userId: string) {
      return { userId, realName: '用户' + userId, deptId: 'D01', deptName: '测试部门', postId: 'P01', postName: '测试岗位' }
    },
  }
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
/** start → apply → review → final → end；两参数分别控制申请节点与审批节点的 properties。 */
function chain(applyProps: Record<string, any>, reviewProps: Record<string, any>): string {
  return JSON.stringify({
    name: `dcsign-${++seq}`, displayName: '动态会签夹具', type: 'approval',
    nodes: [
      nodeOf('start', 'snaker:start', {}, '开始'),
      nodeOf('apply', 'snaker:task', { form: 'apply-form', assignee: 'applicant', taskType: 0, performType: 0, ...applyProps }, '发起申请'),
      nodeOf('review', 'snaker:task', { form: 'form-r', assignee: 'userA', taskType: 0, performType: 0, ...reviewProps }, '审批'),
      nodeOf('final', 'snaker:task', { form: 'form-f', assignee: 'userF', taskType: 0, performType: 0 }, '终审'),
      nodeOf('end', 'snaker:end', {}, '结束'),
    ],
    edges: [edgeOf('e1', 'start', 'apply'), edgeOf('e2', 'apply', 'review'),
      edgeOf('e3', 'review', 'final'), edgeOf('e4', 'final', 'end')],
  })
}

function registerFlowJson(repo: MemoryRepository, jsonStr: string): ProcessDefine {
  const raw = JSON.parse(jsonStr)
  const def: ProcessDefine = {
    id: '', name: raw.name, displayName: raw.displayName ?? '动态会签夹具', type: raw.type ?? 'approval',
    state: 1, content: jsonStr, version: 1,
  } as ProcessDefine
  repo.addDefine(def)
  return def
}

/** 发起并办结申请节点，返回停在 review（征询档）的实例。 */
async function startToReview(repo: MemoryRepository, engine: any, reviewProps: Record<string, any>) {
  const def = registerFlowJson(repo, chain({}, reviewProps))
  const started = await engine.startProcessInstanceById(def.id, 'applicant', {})
  for (const t of await repo.findDoingTasks(started.id)) {
    await engine.executeProcessTask(t.id, 'applicant', { [KeySubmitType]: APPLY })
  }
  return (await repo.findInstanceById(started.id))!
}

const doing = async (repo: MemoryRepository, iid: string, name: string) =>
  (await repo.findDoingTasks(iid)).find(t => t.taskName === name)
const doingOf = async (repo: MemoryRepository, iid: string, actor: string) =>
  (await repo.findDoingTasks(iid)).find(t => (t.actorIds ?? []).includes(actor))
const doingCount = async (repo: MemoryRepository, iid: string, name: string) =>
  (await repo.findDoingTasks(iid)).filter(t => t.taskName === name).length
const rowsOf = async (repo: MemoryRepository, iid: string, name: string) =>
  (await repo.findHistoryTasks(iid)).filter(t => t.taskName === name)
const firstActor = (t: ProcessTask) => (t.actorIds?.length ? t.actorIds[0] : undefined)

/** 发起一轮征询（走门面 execute 腿）；返回响应信封。 */
async function launch(facade: JeeflowFacade, host: ProcessTask, operator: string,
  operators: string | string[], extra: Record<string, any> = {}) {
  return facade.flow('processTask/execute', {
    processTaskId: host.id, operator, submitType: AGREE,
    [KeyAddSignOperators]: operators, ...extra,
  })
}
/** 普通办理（走门面 execute 腿）。 */
const submit = (facade: JeeflowFacade, task: ProcessTask, operator: string, submitType: number = AGREE) =>
  facade.flow('processTask/execute', { processTaskId: task.id, operator, submitType })

/** 报错即零写入的三件核对：主办行仍 DOING、实例仍进行中、本节点行数不变。 */
async function assertHostUntouched(repo: MemoryRepository, host: ProcessTask, iid: string, beforeRows: number) {
  const row = (await repo.findTaskById(host.id))!
  assert.equal(row.taskState, TaskState.Doing, '报错时主办行不得被办结')
  assert.equal((await repo.findInstanceById(iid))!.state, InstanceState.Doing, '实例状态不得被动')
  assert.equal((await rowsOf(repo, iid, host.taskName)).length, beforeRows, '报错时不得新增行')
}

describe('动态会签（征询模式 dynamicCountersign）（Node）', () => {
  // ═══ 正向：发起分流 ═══

  it('01 带人提交＝只建成员行、不办结主办行；响应 marker＋三戳＋逐行码 3', async () => {
    const { engine, repo, fired } = setup()
    const inst = await startToReview(repo, engine, DC_ON)
    const host = (await doing(repo, inst.id, 'review'))!
    assert.ok(host, '应停在审批节点')
    fired.length = 0

    const res = await launch(new JeeflowFacade(engine, repo), host, 'userA', ['userB', 'userC'])
    assert.equal(res.code, 0, JSON.stringify(res))
    assert.deepEqual(res.data.dynamicCountersign, { round: 1, total: 2, submitted: 0 }, 'marker 三键')
    // 主办行不办结＝征询挂起
    const hostRow = (await repo.findTaskById(host.id))!
    assert.equal(hostRow.taskState, TaskState.Doing, '主办行必须仍未办结')
    assert.equal(hostRow.actorId, '', '主办行不得被写成已办理')
    assert.equal(Number(hostRow.variables[ROUND_KEY]), 1, '主办行同步盖轮次戳')
    const hist = historyOf(hostRow)
    assert.equal(hist.length, 1, '账本落主办行、恰一条')
    assert.deepEqual(Object.keys(hist[0]), ['round', 'fromActor', 'toActors', 'time', 'operator'], '五键固定顺序')
    assert.equal(hist[0].round, 1)
    assert.equal(hist[0].fromActor, 'userA')
    assert.deepEqual(hist[0].toActors, ['userB', 'userC'])
    assert.match(String(hist[0].time), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    assert.equal(hist[0].reason, undefined, 'reason 空 ⇒ 账本不写键')
    // 令牌停留本节点
    assert.equal(await doing(repo, inst.id, 'final'), undefined, '不得放行出边')
    // 成员行：一人一行、同节点同名、parent＝主办行、performType 普通、form 继承
    const members = (await rowsOf(repo, inst.id, 'review')).filter(t => t.parentTaskId === host.id)
    assert.equal(members.length, 2)
    for (const m of members) {
      assert.equal(m.taskName, 'review', '成员行同节点同名')
      assert.equal(m.taskState, TaskState.Doing)
      assert.equal(m.performType, 0, '成员行是普通任务行，不是会签')
      assert.equal(m.formKey, 'form-r', 'form 继承节点配置')
      assert.equal(Number(m.variables[ROUND_KEY]), 1, '轮次戳盖每条成员行')
      assert.equal(m.variables[KeyAddSignReason], undefined)
    }
    assert.deepEqual(members.map(m => firstActor(m)).sort(), ['userB', 'userC'])
    // 逐行码 3（成员行建单走既有建单腿）
    assert.equal(fired.filter(e => e.type === EventType.ProcessTaskStart).length, 2, '两条成员行各 fire 码 3')
    assert.equal(fired.filter(e => e.type === EventType.TaskComplete).length, 0, '主办未办结 ⇒ 不发码 5')
    assert.equal(fired.filter(e => e.type === EventType.TaskReject).length, 0, '不发码 6')
  })

  it('02 reason 选填：非空 ⇒ 盖每条成员行＋账本条目（单行出证自足）', async () => {
    const { engine, repo } = setup()
    const inst = await startToReview(repo, engine, DC_ON)
    const host = (await doing(repo, inst.id, 'review'))!
    const facade = new JeeflowFacade(engine, repo)
    const res = await launch(facade, host, 'userA', ['userB', 'userC'], { [KeyAddSignReason]: '请部门复核' })
    assert.equal(res.code, 0, JSON.stringify(res))
    const members = (await rowsOf(repo, inst.id, 'review')).filter(t => t.parentTaskId === host.id)
    assert.ok(members.every(m => m.variables[KeyAddSignReason] === '请部门复核'))
    assert.equal(historyOf((await repo.findTaskById(host.id))!)[0].reason, '请部门复核')
  })

  // ═══ 闸门 ═══

  it('03 闸门逐字文案：主办未收齐 ⇒ AGREE 也挡，报错即零写入', async () => {
    const { engine, repo, facade } = setup()
    const inst = await startToReview(repo, engine, DC_ON)
    const host = (await doing(repo, inst.id, 'review'))!
    await launch(facade, host, 'userA', ['userB', 'userC'])
    const before = (await rowsOf(repo, inst.id, 'review')).length
    const res = await submit(facade, host, 'userA')
    assert.equal(res.code, 99999999, JSON.stringify(res))
    assert.equal(res.msg, msgPending('review', 0, 2), '逐字文案（已提交 m/n）')
    assert.equal(res.msg, '节点[review]动态会签意见未收齐（已提交 0/2），不能办理')
    await assertHostUntouched(repo, host, inst.id, before)
    assert.equal(await doing(repo, inst.id, 'final'), undefined)
  })

  it('04 闸门挡全部 submitType：驳回(2) 同样挡（唯一出口＝撤回接口）', async () => {
    const { engine, repo, facade } = setup()
    const inst = await startToReview(repo, engine, DC_ON)
    const host = (await doing(repo, inst.id, 'review'))!
    await launch(facade, host, 'userA', 'userB')
    const before = (await rowsOf(repo, inst.id, 'review')).length
    const res = await submit(facade, host, 'userA', REJECT)
    assert.equal(res.code, 99999999, JSON.stringify(res))
    assert.equal(res.msg, msgPending('review', 0, 1))
    await assertHostUntouched(repo, host, inst.id, before)
    assert.equal((await repo.findInstanceById(inst.id))!.state, InstanceState.Doing, '驳回被挡 ⇒ 实例不得进终态')
  })

  it('05 成员行禁带拉人参数 ⇒ 逐字报错＋零写入', async () => {
    const { engine, repo, facade } = setup()
    const inst = await startToReview(repo, engine, DC_ON)
    const host = (await doing(repo, inst.id, 'review'))!
    await launch(facade, host, 'userA', 'userB')
    const b = (await doingOf(repo, inst.id, 'userB'))!
    assert.ok(b, '成员行应有一条 userB 的待办')
    const before = (await rowsOf(repo, inst.id, 'review')).length
    const res = await launch(facade, b, 'userB', 'userD')
    assert.equal(res.code, 99999999, JSON.stringify(res))
    assert.equal(res.msg, MSG_MEMBER_PULL)
    const row = (await repo.findTaskById(b.id))!
    assert.equal(row.taskState, TaskState.Doing, '成员行不得被办结')
    assert.equal((await rowsOf(repo, inst.id, 'review')).length, before, '不得再建下级行')
  })

  it('06 建前四拦：开关未开／非主办参与人／加给自己／该人已有未答成员行，全部零写入', async () => {
    const { engine, repo } = setup()
    // ① 开关未开：非征询节点带人 ⇒ 仍由后加签那条判据报它的逐字文案（分流不吞别档）
    const plainInst = await startToReview(repo, engine, {})
    const plainHost = (await doing(repo, plainInst.id, 'review'))!
    const f1 = new JeeflowFacade(engine, repo)
    const r1 = await launch(f1, plainHost, 'userA', 'userB')
    assert.equal(r1.code, 99999999, JSON.stringify(r1))
    assert.match(String(r1.msg), /未开启 allowAddSign，不接受 tf_addSignOperators/)
    assert.equal((await repo.findTaskById(plainHost.id))!.taskState, TaskState.Doing)

    const inst = await startToReview(repo, engine, DC_ON)
    const host = (await doing(repo, inst.id, 'review'))!
    const f2 = new JeeflowFacade(engine, repo)
    const before = (await rowsOf(repo, inst.id, 'review')).length
    // ② 操作人不是主办参与人
    const r2 = await launch(f2, host, 'userZ', 'userB')
    assert.equal(r2.code, 99999999, JSON.stringify(r2))
    assert.equal(r2.msg, MSG_NOT_ALLOWED_EXECUTE)
    await assertHostUntouched(repo, host, inst.id, before)
    // ③ 加给自己
    const r3 = await launch(f2, host, 'userA', 'userA')
    assert.equal(r3.code, 99999999, JSON.stringify(r3))
    assert.equal(r3.msg, MSG_SELF)
    await assertHostUntouched(repo, host, inst.id, before)
    // ④ 该人尚无未答成员行 ⇒ 第一轮合法（逗号串/数组两形都归一）
    const r4 = await launch(f2, host, 'userA', 'userB')
    assert.equal(r4.code, 0, JSON.stringify(r4))
    // ⑤ 同一人已有一条未答成员行 ⇒ 再拉一次报错（防重复拉）
    const r5 = await launch(f2, host, 'userA', 'userB')
    assert.equal(r5.code, 99999999, JSON.stringify(r5))
    assert.equal(r5.msg, msgDuplicate('userB', 'review'))
    const after = (await rowsOf(repo, inst.id, 'review')).length
    assert.equal(after, before + 1, '⑤ 那次零写入：行数仍是 ④ 之后那一条成员行')
  })

  it('07 与 tf_nextNodeOperator 同传 ⇒ 互斥逐字报错＋零写入', async () => {
    const { engine, repo, facade } = setup()
    const inst = await startToReview(repo, engine, DC_ON)
    const host = (await doing(repo, inst.id, 'review'))!
    const before = (await rowsOf(repo, inst.id, 'review')).length
    const res = await launch(facade, host, 'userA', 'userB', { tf_nextNodeOperator: 'userF' })
    assert.equal(res.code, 99999999, JSON.stringify(res))
    assert.equal(res.msg, MSG_MUTEX)
    await assertHostUntouched(repo, host, inst.id, before)
  })

  it('07b addSignMaxRounds 对征询档同样生效（两模式共用那一枚上限）', async () => {
    const { engine, repo, facade } = setup()
    const inst = await startToReview(repo, engine, { ...DC_ON, addSignMaxRounds: 1 })
    const host = (await doing(repo, inst.id, 'review'))!
    assert.equal((await launch(facade, host, 'userA', 'userB')).code, 0, '第 1 轮合法')
    const b = (await doingOf(repo, inst.id, 'userB'))!
    assert.equal((await submit(facade, b, 'userB')).code, 0)
    const before = (await rowsOf(repo, inst.id, 'review')).length
    const res = await launch(facade, host, 'userA', 'userC')
    assert.equal(res.code, 99999999, JSON.stringify(res))
    assert.match(String(res.msg), /的加签轮次已达上限 1，本次提交被拒绝/)
    await assertHostUntouched(repo, host, inst.id, before)
  })

  // ═══ 征询档推进闸 ═══

  it('08 收齐前成员办结不流转；收齐后主办拍板才放行（拍板权始终在主办）', async () => {
    const { engine, repo, facade } = setup()
    const inst = await startToReview(repo, engine, DC_ON)
    const host = (await doing(repo, inst.id, 'review'))!
    await launch(facade, host, 'userA', ['userB', 'userC'])

    // 第一位成员提交（意见仅作记录、无表决语义：软拒绝 20 也只留痕，不否决、不阻断）
    const b = (await doingOf(repo, inst.id, 'userB'))!
    assert.equal((await submit(facade, b, 'userB', SubmitType.CountersignDisagree)).code, 0,
      '成员按软拒绝提交也只记录')
    assert.equal(await doing(repo, inst.id, 'final'), undefined, '主办还 DOING ⇒ 节点不动')
    assert.equal((await repo.findInstanceById(inst.id))!.state, InstanceState.Doing,
      '成员那一手的 submitType 不产生表决语义 ⇒ 流程不阻断')

    const c = (await doingOf(repo, inst.id, 'userC'))!
    assert.equal((await submit(facade, c, 'userC')).code, 0)
    assert.equal(await doing(repo, inst.id, 'final'), undefined, '成员全部办结但主办未拍板 ⇒ 仍不流转')
    assert.equal(await doingCount(repo, inst.id, 'review'), 1, '本节点只剩主办那一条待办')

    // 收齐后主办拍板同意 ⇒ 放行出边
    const hostRow = (await repo.findTaskById(host.id))!
    const final = await submit(facade, hostRow, 'userA')
    assert.equal(final.code, 0, JSON.stringify(final))
    const fin = (await doing(repo, inst.id, 'final'))!
    assert.ok(fin, '主办拍板后才流出本节点')
    assert.equal(await doingCount(repo, inst.id, 'final'), 1, '放行只发生一次')
  })

  it('09 多轮跨轮计数：第二轮拉人后闸门按整册计数（已提交 1/2）', async () => {
    const { engine, repo, facade } = setup()
    const inst = await startToReview(repo, engine, DC_ON)
    const host = (await doing(repo, inst.id, 'review'))!
    assert.equal((await launch(facade, host, 'userA', 'userB')).data.dynamicCountersign.round, 1)
    const b = (await doingOf(repo, inst.id, 'userB'))!
    await submit(facade, b, 'userB')
    const r2 = await launch(facade, host, 'userA', 'userC')
    assert.equal(r2.code, 0, JSON.stringify(r2))
    assert.deepEqual(r2.data.dynamicCountersign, { round: 2, total: 2, submitted: 1 }, '跨轮计数')
    const c = (await doingOf(repo, inst.id, 'userC'))!
    assert.equal(Number(c.variables[ROUND_KEY]), 2, '第二轮的成员行盖 2')
    const res = await submit(facade, host, 'userA')
    assert.equal(res.code, 99999999, JSON.stringify(res))
    assert.equal(res.msg, msgPending('review', 1, 2))
    const hostRow = (await repo.findTaskById(host.id))!
    assert.equal(Number(hostRow.variables[ROUND_KEY]), 2, '主办行的轮次戳跟到第二轮')
    assert.equal(historyOf(hostRow).length, 2, '账本两轮各一条')
  })

  // ═══ 撤回动态会签 ═══

  it('10 撤回：废弃未答行＋已交意见保留＋账本 revoked 条目＋闸门恢复＋轮次不消耗', async () => {
    const { engine, repo, facade } = setup()
    const inst = await startToReview(repo, engine, DC_ON)
    const host = (await doing(repo, inst.id, 'review'))!
    await launch(facade, host, 'userA', ['userB', 'userC'])
    const b = (await doingOf(repo, inst.id, 'userB'))!
    await submit(facade, b, 'userB')
    const c = (await doingOf(repo, inst.id, 'userC'))!

    const res = await facade.flow('processTask/revokeDynamicCountersign',
      { processTaskId: host.id, operator: 'userA', reason: '意见已线下收集' })
    assert.equal(res.code, 0, JSON.stringify(res))
    assert.equal(res.data.revoked, 1)
    assert.deepEqual(res.data.actors, ['userC'])
    assert.equal((await repo.findTaskById(c.id))!.taskState, TaskState.Abandoned, '未答成员行废弃(99)')
    assert.equal((await repo.findTaskById(c.id))!.updateUser, 'userA', '废弃行的 update_user 记撤回人')
    assert.equal((await repo.findTaskById(b.id))!.taskState, TaskState.Done, '已交意见行原样保留（审计凭证不动）')
    const hostRow = (await repo.findTaskById(host.id))!
    assert.equal(hostRow.taskState, TaskState.Doing, '主办行仍挂起，等自己拍板')
    const hist = historyOf(hostRow)
    assert.equal(hist.length, 2, '撤回追加一条（只追加不覆盖）')
    assert.equal(hist[1].revoked, true)
    assert.deepEqual(hist[1].toActors, ['userC'])
    assert.equal(hist[1].round, 1, '撤回条目记当轮，不推进轮次')
    assert.equal(hist[1].reason, '意见已线下收集')
    // 闸门自然恢复 ⇒ 主办可直接拍板
    const after = (await repo.findTaskById(host.id))!
    assert.equal((await submit(facade, after, 'userA')).code, 0, '撤完即无未答行 ⇒ 闸门开')
    assert.ok(await doing(repo, inst.id, 'final'), '主办拍板后流出本节点')
  })

  it('11 撤回后轮次不消耗（再拉一轮是第二轮）＋二次撤回逐字文案', async () => {
    const { engine, repo, facade } = setup()
    const inst = await startToReview(repo, engine, DC_ON)
    const host = (await doing(repo, inst.id, 'review'))!
    await launch(facade, host, 'userA', 'userB')
    assert.equal((await facade.flow('processTask/revokeDynamicCountersign',
      { processTaskId: host.id, operator: 'userA' })).code, 0)
    const again = await facade.flow('processTask/revokeDynamicCountersign',
      { processTaskId: host.id, operator: 'userA' })
    assert.equal(again.code, 99999999, JSON.stringify(again))
    assert.equal(again.msg, msgNoPending('review'), '无待答成员行 ⇒ 逐字文案')
    assert.equal(again.msg, '节点[review]没有进行中的动态会签')
    const r2 = await launch(facade, host, 'userA', 'userC')
    assert.equal(r2.code, 0, JSON.stringify(r2))
    assert.equal(r2.data.dynamicCountersign.round, 2, '撤回不消耗轮次 ⇒ 第二次拉人是第二轮')
    assert.equal(r2.data.dynamicCountersign.total, 1, '99 那行不算在册')
  })

  it('12 撤回鉴权与参数档：operator 必填／主键缺失／非参与者／非征询节点／任务不存在', async () => {
    const { engine, repo, facade } = setup()
    const inst = await startToReview(repo, engine, DC_ON)
    const host = (await doing(repo, inst.id, 'review'))!
    await launch(facade, host, 'userA', 'userB')

    const noOp = await facade.flow('processTask/revokeDynamicCountersign', { processTaskId: host.id, operator: '' })
    assert.equal(noOp.msg, 'operator 必填', JSON.stringify(noOp))
    const noId = await facade.flow('processTask/revokeDynamicCountersign', { operator: 'userA' })
    assert.match(String(noId.msg), /id 缺失或非法/)
    const notActor = await facade.flow('processTask/revokeDynamicCountersign',
      { processTaskId: host.id, operator: 'userZ' })
    assert.equal(notActor.code, 99999999, JSON.stringify(notActor))
    assert.equal(notActor.msg, MSG_NO_PERMISSION_REVOKE)
    assert.equal((await doingOf(repo, inst.id, 'userB'))!.taskState, TaskState.Doing, '被拒那次零写入')
    // flow.admin 放行（与转办/实例撤回同口径）
    const priv = await facade.flow('processTask/revokeDynamicCountersign',
      { processTaskId: host.id, operator: 'flow.admin' })
    assert.equal(priv.code, 0, JSON.stringify(priv))
    // 非征询节点 ⇒ 没有进行中的动态会签
    const plainInst = await startToReview(repo, engine, {})
    const plainHost = (await doing(repo, plainInst.id, 'review'))!
    await engine.executeProcessTask(plainHost.id, 'userA', { [KeySubmitType]: AGREE })
    const done = (await rowsOf(repo, plainInst.id, 'review'))[0]
    const wrong = await facade.flow('processTask/revokeDynamicCountersign',
      { processTaskId: done.id, operator: 'userA' })
    assert.equal(wrong.code, 99999999, JSON.stringify(wrong))
    assert.equal(wrong.msg, msgNoPending('review'))
    // 任务不存在
    const missing = await facade.flow('processTask/revokeDynamicCountersign',
      { processTaskId: '999999998', operator: 'userA' })
    assert.equal(missing.msg, '任务不存在', JSON.stringify(missing))
  })

  // ═══ 废弃腿扩双开关 ═══

  it('13 废弃腿扩双开关：成员行按拒绝 ⇒ 主办行与兄弟成员行一并清场，不留孤儿待办', async () => {
    const { engine, repo, facade } = setup()
    const inst = await startToReview(repo, engine, DC_ON)
    const host = (await doing(repo, inst.id, 'review'))!
    await launch(facade, host, 'userA', ['userB', 'userC'])
    const b = (await doingOf(repo, inst.id, 'userB'))!
    const c = (await doingOf(repo, inst.id, 'userC'))!
    const res = await submit(facade, b, 'userB', REJECT)
    assert.equal(res.code, 0, JSON.stringify(res))
    assert.equal((await repo.findInstanceById(inst.id))!.state, InstanceState.Reject, '实例进拒绝终态(45)')
    assert.equal((await repo.findTaskById(host.id))!.taskState, TaskState.Abandoned, '主办行被清场')
    assert.equal((await repo.findTaskById(c.id))!.taskState, TaskState.Abandoned, '兄弟成员行被清场')
    assert.equal((await repo.findTaskById(b.id))!.taskState, TaskState.Done, '拒绝的那一成员行本身是已完成')
    assert.equal(await doingCount(repo, inst.id, 'review'), 0, '本节点不留任何待办')
  })

  it('13b 实例撤回（非 execute 通道）也不留孤儿待办：主办与成员行一并撤回', async () => {
    const { engine, repo, facade } = setup()
    const inst = await startToReview(repo, engine, DC_ON)
    const host = (await doing(repo, inst.id, 'review'))!
    await launch(facade, host, 'userA', 'userB')
    const res = await facade.flow('processInstance/withdraw', { id: inst.id, operator: 'applicant' })
    assert.equal(res.code, 0, JSON.stringify(res))
    assert.equal((await repo.findInstanceById(inst.id))!.state, InstanceState.Withdraw)
    assert.equal(await doingCount(repo, inst.id, 'review'), 0, '主办＋成员行都不得留待办')
  })

  // ═══ 投影 ═══

  it('14 投影 ext.dynamicCountersign：active 随收齐翻转、跳过 99 废弃行、actors 逐行读数', async () => {
    const { engine, repo, facade } = setup()
    const inst = await startToReview(repo, engine, DC_ON)
    const host = (await doing(repo, inst.id, 'review'))!
    // 无成员行 ⇒ 不写键
    const bare = await facade.flow('processTask/detail', { id: host.id, operator: 'userA' })
    assert.equal(bare.code, 0, JSON.stringify(bare))
    assert.equal(bare.data.ext.dynamicCountersign, undefined, '无成员行 ⇒ 投影不写键')

    await launch(facade, host, 'userA', ['userB', 'userC'])
    const d1 = await facade.flow('processTask/detail', { id: host.id, operator: 'userA' })
    const p1 = d1.data.ext.dynamicCountersign
    assert.deepEqual(Object.keys(p1), ['active', 'round', 'total', 'submitted', 'actors'])
    assert.equal(p1.active, true, '未收齐 ⇒ active 真')
    assert.equal(p1.round, 1)
    assert.equal(p1.total, 2)
    assert.equal(p1.submitted, 0)
    assert.deepEqual(p1.actors.map((a: any) => a.actor).sort(), ['userB', 'userC'])
    assert.equal(p1.actors.every((a: any) => a.state === TaskState.Doing), true)
    assert.ok(p1.actors.every((a: any) => a.taskId), 'actors 带成员行 id（前端可直达那一行）')

    const b = (await doingOf(repo, inst.id, 'userB'))!
    await submit(facade, b, 'userB')
    const p2 = (await facade.flow('processTask/detail', { id: host.id, operator: 'userA' })).data.ext.dynamicCountersign
    assert.equal(p2.submitted, 1)
    assert.equal(p2.active, true)
    assert.equal(p2.actors.find((a: any) => a.actor === 'userB').state, TaskState.Done)

    // 撤回未答的那条 ⇒ 99 行不进投影，计数只算在册
    await facade.flow('processTask/revokeDynamicCountersign', { processTaskId: host.id, operator: 'userA' })
    const p3 = (await facade.flow('processTask/detail', { id: host.id, operator: 'userA' })).data.ext.dynamicCountersign
    assert.equal(p3.total, 1, '99 行跳过 ⇒ 在册只剩已交那条')
    assert.equal(p3.submitted, 1)
    assert.equal(p3.active, false, '收齐（无未答）⇒ active 翻假')
    assert.equal(p3.actors.length, 1)
  })

  it('14b 纯函数投影/计数自证：成员行识别靠 parent＋同节点同名', async () => {
    const { engine, repo, facade } = setup()
    const inst = await startToReview(repo, engine, DC_ON)
    const host = (await doing(repo, inst.id, 'review'))!
    await launch(facade, host, 'userA', 'userB')
    const tasks = await repo.findHistoryTasks(inst.id)
    const hostRow = tasks.find(t => t.id === host.id)!
    assert.deepEqual(memberCounts(tasks, hostRow), [1, 0])
    assert.equal(buildProjection(tasks, hostRow)?.total, 1)
    // 主办办结推进后，下游 final 行的 parent 同样是主办行 id ⇒ 不得被认作成员行
    const b = (await doingOf(repo, inst.id, 'userB'))!
    await submit(facade, b, 'userB')
    const hostRow2 = (await repo.findTaskById(host.id))!
    await submit(facade, hostRow2, 'userA')
    const tasks2 = await repo.findHistoryTasks(inst.id)
    const fin = tasks2.find(t => t.taskName === 'final')!
    assert.equal(String(fin.parentTaskId), String(host.id), '前置：final 行的 parent＝主办行 id')
    const doneHost = tasks2.find(t => t.id === host.id)!
    assert.deepEqual(memberCounts(tasks2, doneHost), [1, 1], 'final 行不得被当成成员行计数')
    assert.equal(buildProjection(tasks2, doneHost)?.actors.length, 1)
  })

  // ═══ 三条解析期禁配 ＋ 非法值 ═══

  it('15 三条解析期禁配（双开／会签节点／申请节点）', () => {
    const mutex = JSON.parse(chain({}, { allowAddSign: true, dynamicCountersign: true }))
    assert.throws(() => checkFlowConfig(mutex), /不允许同时配置 allowAddSign 与 dynamicCountersign/)
    const cs = JSON.parse(chain({}, { ...DC_ON, performType: 1, countersignType: 'PARALLEL' }))
    assert.throws(() => checkFlowConfig(cs), /会签节点\[review\]不允许配置 dynamicCountersign/)
    const apply = JSON.parse(chain(DC_ON, DC_ON))
    assert.throws(() => checkFlowConfig(apply), /申请节点\[apply\]不允许配置 dynamicCountersign/)
  })

  it('16 dynamicCountersign 非法值 ⇒ 解析期报错，不得静默当缺省', () => {
    assert.throws(() => checkFlowConfig(JSON.parse(chain({}, { dynamicCountersign: 'yes' }))),
      /节点\[review\]的 dynamicCountersign 配置非法: yes/)
    checkFlowConfig(JSON.parse(chain({}, { dynamicCountersign: 'true' })))
    checkFlowConfig(JSON.parse(chain({}, {})))
  })

  it('17 发布腿即拒：带病的 dynamicCountersign 配置在 deploy 就红', async () => {
    const { engine, repo } = setup()
    const facade = new JeeflowFacade(engine, repo)
    const bad = await facade.flow('processDefine/deploy',
      { content: chain({}, { allowAddSign: true, ...DC_ON }), operator: 'admin' })
    assert.equal(bad.code, 99999999, JSON.stringify(bad))
    assert.match(String(bad.msg), /不允许同时配置 allowAddSign 与 dynamicCountersign/)
    const good = await facade.flow('processDefine/deploy', { content: chain({}, DC_ON), operator: 'admin' })
    assert.equal(good.code, 0, JSON.stringify(good))
  })

  // ═══ 回归 ═══

  it('18 不开开关的节点行为逐字不变（普通办理、零账本、零投影）', async () => {
    const { engine, repo, facade } = setup()
    const inst = await startToReview(repo, engine, {})
    const host = (await doing(repo, inst.id, 'review'))!
    const res = await submit(facade, host, 'userA')
    assert.equal(res.code, 0, JSON.stringify(res))
    assert.equal(res.data, null, '非征询提交不带 marker')
    assert.ok(await doing(repo, inst.id, 'final'))
    assert.deepEqual(historyOf((await repo.findTaskById(host.id))!), [])
    const d = await facade.flow('processTask/detail', { id: host.id, operator: 'userA' })
    assert.equal(d.data.ext.dynamicCountersign, undefined)
  })

  it('19 tf_ 控制键不进实例变量（征询模式根因同一条）', async () => {
    const { engine, repo, facade } = setup()
    const inst = await startToReview(repo, engine, DC_ON)
    const host = (await doing(repo, inst.id, 'review'))!
    await launch(facade, host, 'userA', 'userB', { [KeyAddSignReason]: '复核', tf_approvalComment: '请 B 复核' })
    const vars = (await repo.findInstanceById(inst.id))!.variables
    for (const key of Object.keys(vars)) {
      assert.ok(!key.startsWith('tf_'), `实例变量里不应有任何 tf_ 键: ${key}`)
    }
    // 主办行未办结 ⇒ 账本与留痕都在那一行上（征询模式下主办行活着）
    const hostRow = (await repo.findTaskById(host.id))!
    assert.equal(hostRow.variables.tf_approvalComment, undefined, '未办结 ⇒ 提交参数不落主办行')
    assert.equal(historyOf(hostRow).length, 1)
    // 主办办结后账本活下来（合并序：completeTask 收整包 args，账本由行上既有键续存）
    const b = (await doingOf(repo, inst.id, 'userB'))!
    await submit(facade, b, 'userB')
    await submit(facade, (await repo.findTaskById(host.id))!, 'userA')
    assert.equal(historyOf((await repo.findTaskById(host.id))!).length, 1, '办结后账本仍在主办行上')
    assert.equal((await repo.findInstanceById(inst.id))!.variables[KeyAddSignHistory], undefined,
      '账本不并进实例变量')
  })

  // ═══ 逐字文案与键名常量自证 ═══

  it('20 文案与键名常量自证', () => {
    assert.equal(PROP_DYNAMIC_COUNTERSIGN, 'dynamicCountersign')
    assert.equal(KeyAddSignReason, 'tf_addSignReason')
    assert.equal(msgPending('n1', 1, 3), '节点[n1]动态会签意见未收齐（已提交 1/3），不能办理')
    assert.equal(msgDuplicate('u1', 'n1'), '操作人[u1]已在节点[n1]的动态会签中')
    assert.equal(MSG_MEMBER_PULL, '动态会签成员任务不能发起加签')
    assert.equal(msgNoPending('n1'), '节点[n1]没有进行中的动态会签')
    assert.equal(MSG_NO_PERMISSION_REVOKE, '无权限撤回该动态会签')
    assert.equal(MSG_NOT_ALLOWED_EXECUTE, '当前参与者不能执行该流程任务')
    assert.equal(msgMutexWithAddSign('n1'),
      '节点[n1]不允许同时配置 allowAddSign 与 dynamicCountersign：' +
      '两档共用 tf_addSignOperators，行为靠节点属性分流，双开＝行为歧义')
    assert.equal(msgCollectCountersignForbid('n1'),
      '会签节点[n1]不允许配置 dynamicCountersign：会签池推进语义与征询挂起语义打架')
    assert.equal(msgCollectApplyForbid('n1'),
      '申请节点[n1]不允许配置 dynamicCountersign：申请节点那手走实例撤回＋重新发起，不需要征询挂起')
  })
})
