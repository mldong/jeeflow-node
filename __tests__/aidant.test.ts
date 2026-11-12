/**
 * 「动态协办（aidant）」验收（Node 栈，issues/253）——移植基准＝jeeflow-java 参考实现
 * `core/AidantSupport.java` ＋ `JeeflowEngineImpl.aidantTask`／`completeAidantWithoutDrive`／
 * `prepareExecution` 的 `gateWait` ＋ `model/TaskModel.abandonAidantOnLeave` ＋
 * `handler/impl/CountersignHandler`（会签合并显式排除协办行）＋ `test/AidantTest.java`（34 例）；
 * 交叉样本＝go `engine/aidant.go`＋`facade/aidant_253_test.go` 与
 * python `jeeflow/aidant.py`＋`tests/test_aidant.py`。
 *
 * 覆盖：派生形状（task_type=1／parent＝主办行／同节点同名／performType=NORMAL／expire_time 同尺／
 * 委托并入／码 3 既有腿）、推进闸（协办行办结不驱动，execute／jump／reject／退发起人四入口同闸）、
 * 等待闸两档（waitCompletion=true 逐字文案＋零写入／缺省 false 随时推进＋离开节点清场记账）、
 * 两跳账本存活、detail 投影形状、协办行能力边界（可加/摘人、可被转办、禁递归）、
 * 负向六文案＋越权＋非 DOING、回归（会签票齐即推进不被协办挡／与征询并存两闸各数／撤回清场／
 * transfer·surrogate·addCandidate 不变）。
 *
 * 夹具走内联 JSON（{@link chain}），不碰共享 `flows/` 目录（同 dynamic-countersign.test.ts 纪律）。
 * 既有测试期望值一字未改（唯一例外＝action 条数形状锚 7→8，本轮同批 +1，见 action-permission.test.ts）。
 */
import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { EngineImpl, KeySubmitType } from '../src/engine.js'
import { JeeflowFacade } from '../src/facade.js'
import { KeyAddSignOperators } from '../src/addsign.js'
import * as C from '../src/collect.js'
import * as AD from '../src/aidant.js'
import { MemoryRepository } from '../src/memory.js'
import { MemoryExtRepository } from '../src/memory-ext.js'
import {
  InstanceState, SubmitType, TaskState, TaskType, PerformType,
  type ProcessDefine, type ProcessSurrogate, type ProcessTask,
} from '../src/model.js'
import { type ProcessEvent } from '../src/extensions.js'
import { ACTION_PERMISSION_OR_RULES, permissionCodes } from '../src/action-permission.js'
import type { ExpressionEvaluator, UserProvider } from '../src/spi.js'

const AGREE = SubmitType.Agree
const REJECT = SubmitType.Reject
const APPLY = SubmitType.Apply
const JUMP = SubmitType.Jump
const ROLLBACK = SubmitType.Rollback
const TO_OPERATOR = SubmitType.RollbackToOperator
const DC_ON = { dynamicCountersign: true }

function setup() {
  const repo = new MemoryRepository()
  const ext = new MemoryExtRepository()
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
  engine.setSurrogateRepository(ext)
  return { engine, repo, ext, fired, facade: new JeeflowFacade(engine, repo, ext) }
}

// ─── 夹具 ─────────────────────────────────────────────────────────────────────

const nodeOf = (id: string, type: string, props: Record<string, any>, text: string) =>
  ({ id, type, x: 0, y: 0, properties: props, text: { value: text } })
const edgeOf = (id: string, from: string, to: string) =>
  ({ id, type: 'snaker:transition', sourceNodeId: from, targetNodeId: to, properties: {} })

let seq = 0
/** start → apply → review → final → end（java AidantTest.chain 同形）。 */
function chain(reviewProps: Record<string, any> = {}): string {
  return JSON.stringify({
    name: `aidant-${++seq}`, displayName: '动态协办夹具', type: 'approval',
    nodes: [
      nodeOf('start', 'snaker:start', {}, '开始'),
      nodeOf('apply', 'snaker:task', { form: 'apply-form', assignee: 'applicant', taskType: 0, performType: 0 }, '发起申请'),
      nodeOf('review', 'snaker:task', { form: 'form-r', assignee: 'userA', taskType: 0, performType: 0, ...reviewProps }, '审批'),
      nodeOf('final', 'snaker:task', { form: 'form-f', assignee: 'userF', taskType: 0, performType: 0 }, '终审'),
      nodeOf('end', 'snaker:end', {}, '结束'),
    ],
    edges: [edgeOf('e1', 'start', 'apply'), edgeOf('e2', 'apply', 'review'),
      edgeOf('e3', 'review', 'final'), edgeOf('e4', 'final', 'end')],
  })
}

/** 并行会签链：start→apply→cs（userA,userB）→end（java countersignChain 同形）。 */
function csChain(): string {
  return JSON.stringify({
    name: `aidant-cs-${++seq}`, displayName: '协办×会签夹具', type: 'approval',
    nodes: [
      nodeOf('start', 'snaker:start', {}, '开始'),
      nodeOf('apply', 'snaker:task', { form: 'apply-form', assignee: 'applicant', taskType: 0, performType: 0 }, '发起申请'),
      nodeOf('cs', 'snaker:task', { form: 'form-c', taskType: 0, performType: 1, assignee: 'userA,userB', countersignType: 'PARALLEL' }, '会签审批'),
      nodeOf('end', 'snaker:end', {}, '结束'),
    ],
    edges: [edgeOf('e1', 'start', 'apply'), edgeOf('e2', 'apply', 'cs'), edgeOf('e3', 'cs', 'end')],
  })
}

function registerFlowJson(repo: MemoryRepository, jsonStr: string): ProcessDefine {
  const raw = JSON.parse(jsonStr)
  const def: ProcessDefine = {
    id: '', name: raw.name, displayName: raw.displayName ?? '动态协办夹具', type: raw.type ?? 'approval',
    state: 1, content: jsonStr, version: 1,
  } as ProcessDefine
  repo.addDefine(def)
  return def
}

/** 部署夹具并发起＋自动办结申请节点，返回停在 review 的实例 id。 */
async function startFlow(repo: MemoryRepository, engine: any, jsonStr: string): Promise<string> {
  const def = registerFlowJson(repo, jsonStr)
  const started = await engine.startProcessInstanceById(def.id, 'applicant', {})
  for (const t of await repo.findDoingTasks(started.id)) {
    await engine.executeProcessTask(t.id, 'applicant', { [KeySubmitType]: APPLY })
  }
  return started.id
}

const doing = async (repo: MemoryRepository, iid: string, name: string) =>
  (await repo.findDoingTasks(iid)).find(t => t.taskName === name)
const doingCount = async (repo: MemoryRepository, iid: string, name: string) =>
  (await repo.findDoingTasks(iid)).filter(t => t.taskName === name).length

/** 一套协办验收夹具（含事件码捕获）。 */
async function fx(reviewProps: Record<string, any> = {}, jsonStr?: string) {
  const s = setup()
  const iid = await startFlow(s.repo, s.engine, jsonStr ?? chain(reviewProps))
  const codes = () => s.fired.map(e => Number(e.type))
  const allTasks = () => s.repo.findHistoryTasks(iid)
  const task = (id: string) => s.repo.findTaskById(id)
  /** 协办行（经引擎判据读回的持久值），按 id 升序＝建单顺序。 */
  const rows = async (host: ProcessTask) =>
    AD.aidantRows(await allTasks(), (await task(host.id))!).sort((a, b) => a.id.localeCompare(b.id))
  const ledger = async (host: ProcessTask) => AD.historyOf(await task(host.id))
  const state = async () => (await s.repo.findInstanceById(iid))!.state
  const aidant = (host: ProcessTask, operator: string | null, actorIds?: any, reason?: string, wait?: any) => {
    const a: Record<string, any> = { processTaskId: host.id, operator }
    if (actorIds !== undefined) a.actorIds = actorIds
    if (reason !== undefined) a.reason = reason
    if (wait !== undefined) a.waitCompletion = wait
    return s.facade.flow('processTask/aidant', a)
  }
  const exec = (row: ProcessTask, operator: string, submitType: number = AGREE, extra: Record<string, any> = {}) =>
    s.facade.flow('processTask/execute', { processTaskId: row.id, operator, submitType, ...extra })
  const detailExt = async (id: string) => {
    const r = await s.facade.flow('processTask/detail', { id })
    assert.equal(r.code, 0, JSON.stringify(r))
    return (r.data?.ext ?? {}) as Record<string, any>
  }
  return { ...s, iid, codes, allTasks, task, rows, ledger, state, aidant, exec, detailExt }
}

const ok = (r: any) => assert.equal(r.code, 0, JSON.stringify(r))
const msg = (r: any, want: string) => {
  assert.equal(r.code, 99999999, `应失败 code=99999999，实得 ${JSON.stringify(r)}`)
  assert.equal(r.msg, want, `文案应逐字 ${want}，实得 ${r.msg}`)
}

describe('动态协办（aidant）（Node）', () => {
  // ═══ 正向：派生形状 ═══

  it('01 派生＝每人一行 task_type=1／parent／同节点同名／NORMAL；主办保留 DOING；账本六键；只走码 3', async () => {
    const f = await fx()
    const host = (await doing(f.repo, f.iid, 'review'))!
    f.fired.length = 0

    const res = await f.aidant(host, 'userA', ['userX', 'userY'], '需两部门协办')
    ok(res)
    assert.equal(res.data, null, '成功 data → null（规范 06）')

    const hostRow = (await f.task(host.id))!
    assert.equal(hostRow.taskState, TaskState.Doing, '主办行保留 DOING')
    assert.deepEqual(hostRow.actorIds, ['userA'], '主办行名册不动')
    assert.equal(hostRow.actorId, '', '严禁覆写任务 actor_id 列（转办那条 ⚠️ 同尺）')

    const rows = await f.rows(host)
    assert.equal(rows.length, 2, '多人每人一行')
    const gotActors: string[] = []
    for (const r of rows) {
      assert.equal(r.taskState, TaskState.Doing)
      assert.equal(r.taskType, TaskType.Secondary, 'task_type=1')
      assert.equal(r.parentTaskId, host.id)
      assert.equal(r.taskName, host.taskName)
      assert.equal(r.displayName, host.displayName, '同名')
      assert.equal(r.performType, PerformType.Normal, 'performType=NORMAL')
      assert.equal(r.variables[AD.KeyAidantReason], '需两部门协办')
      assert.equal(r.variables.tf_approvalComment, undefined, '协办行不占 tf_approvalComment')
      assert.equal(r.actorId, '', '进行中任务 actor_id 列恒无值')
      gotActors.push(r.actorIds[0])
      assert.equal((await f.repo.findTaskActors(r.id)).length, 1, '参与者表真落库')
    }
    assert.deepEqual(gotActors, ['userX', 'userY'])

    const lg = await f.ledger(host)
    assert.equal(lg.length, 1)
    assert.deepEqual(Object.keys(lg[0]), ['round', 'fromActor', 'toActors', 'reason', 'time', 'operator'],
      '账本六键锁定键序')
    assert.equal(lg[0].round, 1)
    assert.equal(lg[0].fromActor, 'userA')
    assert.deepEqual(lg[0].toActors, ['userX', 'userY'])
    assert.equal(lg[0].reason, '需两部门协办')
    assert.equal(lg[0].operator, 'userA')
    assert.match(String(lg[0].time), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, 'time 一律 §2.4 字符串')
    assert.deepEqual(f.codes(), [3, 3], '只走既有码 3（逐协办行一次），不新增事件码')
  })

  it('02 reason 选填：空串兜底进账本，协办行不盖空戳', async () => {
    const f = await fx()
    const host = (await doing(f.repo, f.iid, 'review'))!
    ok(await f.aidant(host, 'userA', 'userX'))
    assert.equal((await f.ledger(host))[0].reason, '')
    assert.equal((await f.rows(host))[0].variables[AD.KeyAidantReason], undefined)
    assert.equal((await f.task(host.id))!.variables.tf_approvalComment, undefined, '主办行也不占审批意见')
  })

  it('03 actorIds 逗号串与数组两形同归一；空白元素丢弃', async () => {
    const f = await fx()
    const host = (await doing(f.repo, f.iid, 'review'))!
    ok(await f.aidant(host, 'userA', ' userX , userY ,'))
    assert.equal((await f.rows(host)).length, 2)
  })

  it('04 expire_time 同尺重算；委托照既有腿并入协办行名册', async () => {
    const f = await fx({ expireTime: '2d' })
    const now = new Date()
    await f.ext.saveSurrogate({
      id: 's1', operator: 'userX', surrogate: 'userS', processName: '',
      startTime: new Date(now.getTime() - 3600_000), endTime: new Date(now.getTime() + 3600_000),
      enabled: 1, createTime: now, createUser: 't', updateTime: now, updateUser: 't',
    } as ProcessSurrogate)
    const host = (await doing(f.repo, f.iid, 'review'))!
    ok(await f.aidant(host, 'userA', 'userX'))
    const child = (await f.rows(host))[0]
    assert.ok(child.expireTime, 'expire_time 按节点表达式同尺重算')
    assert.ok(child.expireTime!.getTime() > now.getTime() + 47 * 3600_000)
    assert.ok(child.actorIds.includes('userX'), '委托并入不摘原人')
    assert.ok(child.actorIds.includes('userS'), '委托照既有腿并入')
    assert.equal((await f.repo.findTaskActors(child.id)).length, 2, '落库参与者表也真带上')
  })

  // ═══ 正向：推进闸（四入口同闸） ═══

  it('05 协办行办结不产生执行对象、不跑输出变迁；主办仍 DOING；只 fire 码 5', async () => {
    const f = await fx()
    const host = (await doing(f.repo, f.iid, 'review'))!
    await f.aidant(host, 'userA', 'userX')
    const child = (await f.rows(host))[0]
    f.fired.length = 0

    const created = await f.engine.executeProcessTask(child.id, 'userX', { [KeySubmitType]: AGREE })
    assert.deepEqual(created, [], '协办办结不产生执行对象（无新任务）')
    assert.equal((await f.task(child.id))!.taskState, TaskState.Done)
    assert.equal((await f.task(host.id))!.taskState, TaskState.Doing, '主办行保留 DOING')
    assert.equal(await doing(f.repo, f.iid, 'final'), undefined, '不跑输出变迁：下游无待办')
    assert.equal(await f.state(), InstanceState.Doing)
    assert.deepEqual(f.codes(), [5], '只走既有码 5，不新增事件码')
  })

  it('06 四入口同闸：JUMP／ROLLBACK 对协办行同样不驱动', async () => {
    const f = await fx()
    const host = (await doing(f.repo, f.iid, 'review'))!
    await f.aidant(host, 'userA', ['userX', 'userY'])
    const rows = await f.rows(host)

    ok(await f.exec(rows[0], 'userX', JUMP, { taskName: 'final' }))
    assert.equal((await f.task(rows[0].id))!.taskState, TaskState.Done)
    assert.equal(await doing(f.repo, f.iid, 'final'), undefined, '跳转路同闸：不得凭空建出 final 待办')

    const created = await f.engine.executeAndJumpTask(rows[1].id, 'userY', { [KeySubmitType]: ROLLBACK })
    assert.deepEqual(created, [])
    assert.equal((await f.task(rows[1].id))!.taskState, TaskState.Done)
    assert.equal((await f.task(host.id))!.taskState, TaskState.Doing, '主办行仍在')
    assert.equal(await doingCount(f.repo, f.iid, 'review'), 1)
  })

  it('07 协办行拒绝／退回发起人同样不驱动（任何 submitType 只办结自己那一行）', async () => {
    const f = await fx()
    const host = (await doing(f.repo, f.iid, 'review'))!
    await f.aidant(host, 'userA', ['userX', 'userY'])
    const rows = await f.rows(host)

    ok(await f.exec(rows[0], 'userX', REJECT))
    assert.equal(await f.state(), InstanceState.Doing, '拒绝不得结束整单')
    ok(await f.exec(rows[1], 'userY', TO_OPERATOR))
    assert.equal(await f.state(), InstanceState.Doing)
    assert.equal((await f.task(host.id))!.taskState, TaskState.Doing)
    assert.equal(await doing(f.repo, f.iid, 'apply'), undefined)
  })

  it('08 主办再办结照常驱动（协办已办结）', async () => {
    const f = await fx()
    const host = (await doing(f.repo, f.iid, 'review'))!
    await f.aidant(host, 'userA', 'userX')
    await f.exec((await f.rows(host))[0], 'userX', AGREE)
    ok(await f.exec(host, 'userA', AGREE))
    assert.ok(await doing(f.repo, f.iid, 'final'), '主办办结才推进')
    assert.equal((await f.task(host.id))!.taskState, TaskState.Done)
  })

  // ═══ 正向／负向：等待闸两档 ═══

  it('09 waitCompletion=true：未齐逐字文案＋零写入；齐了放行推进', async () => {
    const f = await fx()
    const host = (await doing(f.repo, f.iid, 'review'))!
    ok(await f.aidant(host, 'userA', ['userX', 'userY'], undefined, true))
    const rows = await f.rows(host)
    const ledgerBefore = (await f.ledger(host)).length

    msg(await f.exec(host, 'userA', AGREE), '节点[review]协办未办结（已办结 0/2），不能办理')
    assert.equal((await f.task(host.id))!.taskState, TaskState.Doing, '零写入：主办仍 DOING')
    assert.equal(await doing(f.repo, f.iid, 'final'), undefined, '零写入：无下游待办')
    assert.equal((await f.ledger(host)).length, ledgerBefore, '零写入：账本不增')
    for (const r of await f.rows(host)) assert.equal(r.taskState, TaskState.Doing, '零写入：协办行不动')

    await f.exec(rows[0], 'userX', AGREE)
    msg(await f.exec(host, 'userA', AGREE), '节点[review]协办未办结（已办结 1/2），不能办理')

    await f.exec(rows[1], 'userY', AGREE)
    ok(await f.exec(host, 'userA', AGREE))
    assert.ok(await doing(f.repo, f.iid, 'final'))
  })

  it('10 等待闸挡全部 submitType（含拒绝／退回），不只挡同意', async () => {
    const f = await fx()
    const host = (await doing(f.repo, f.iid, 'review'))!
    await f.aidant(host, 'userA', 'userX', undefined, true)
    for (const st of [AGREE, REJECT, TO_OPERATOR]) {
      msg(await f.exec(host, 'userA', st), '节点[review]协办未办结（已办结 0/1），不能办理')
      assert.equal((await f.task(host.id))!.taskState, TaskState.Doing)
    }
    assert.equal(await f.state(), InstanceState.Doing)
  })

  it('11 缺省 false：主办可随时推进，未办结协办行清场＋账本记废弃', async () => {
    const f = await fx()
    const host = (await doing(f.repo, f.iid, 'review'))!
    await f.aidant(host, 'userA', ['userX', 'userY'])
    const rows = await f.rows(host)
    await f.exec(rows[0], 'userX', AGREE)

    ok(await f.exec(host, 'userA', AGREE))
    assert.ok(await doing(f.repo, f.iid, 'final'), '缺省 false 主办可随时推进')
    assert.equal((await f.task(rows[1].id))!.taskState, TaskState.Abandoned, '未办结协办行清场为废弃(99)')
    assert.equal((await f.task(rows[0].id))!.taskState, TaskState.Done, '已办结那条不改写')

    const lg = await f.ledger(host)
    assert.equal(lg.length, 2, '账本应 2 条（派生＋清场）')
    assert.equal(lg[1].abandoned, true)
    assert.deepEqual(lg[1].toActors, ['userY'], '清场 toActors＝被废弃的人')
    assert.equal(lg[1].round, 1, '清场不消耗轮次')
    assert.equal(await doingCount(f.repo, f.iid, 'review'), 0, '不留孤儿待办')
  })

  it('12 waitCompletion 字符串 "true" 两形也认；非法值按缺省 false（不新造文案）', async () => {
    const f = await fx()
    const host = (await doing(f.repo, f.iid, 'review'))!
    ok(await f.aidant(host, 'userA', 'userX', undefined, 'true'))
    msg(await f.exec(host, 'userA', AGREE), '节点[review]协办未办结（已办结 0/1），不能办理')

    const f2 = await fx()
    const h2 = (await doing(f2.repo, f2.iid, 'review'))!
    ok(await f2.aidant(h2, 'userA', 'userX', undefined, '不是布尔'))
    ok(await f2.exec(h2, 'userA', AGREE))
    assert.ok(await doing(f2.repo, f2.iid, 'final'), '非法值按缺省 false')
  })

  it('13 拒绝／退回发起人离开节点：协办行同样清场（废弃腿覆盖）', async () => {
    const f = await fx()
    const h1 = (await doing(f.repo, f.iid, 'review'))!
    await f.aidant(h1, 'userA', 'userX')
    const c1 = (await f.rows(h1))[0]
    ok(await f.exec(h1, 'userA', REJECT))
    assert.equal((await f.task(c1.id))!.taskState, TaskState.Abandoned)
    assert.equal((await f.ledger(h1))[1].abandoned, true)

    const f2 = await fx()
    const h2 = (await doing(f2.repo, f2.iid, 'review'))!
    await f2.aidant(h2, 'userA', 'userX')
    const c2 = (await f2.rows(h2))[0]
    ok(await f2.exec(h2, 'userA', TO_OPERATOR))
    assert.equal((await f2.task(c2.id))!.taskState, TaskState.Abandoned)
    assert.ok(await doing(f2.repo, f2.iid, 'apply'), '退回发起人后申请节点复活')
  })

  // ═══ 正向：账本与投影 ═══

  it('14 两跳账本＝2，且主办办结后仍在（变量合并序保证存活）', async () => {
    const f = await fx()
    const host = (await doing(f.repo, f.iid, 'review'))!
    await f.aidant(host, 'userA', 'userX', '第一轮', false)
    await f.exec((await f.rows(host))[0], 'userX', AGREE)
    await f.aidant(host, 'userA', 'userY', '第二轮', false)

    const lg = await f.ledger(host)
    assert.equal(lg.length, 2, '两跳账本＝2')
    assert.equal(lg[0].round, 1)
    assert.equal(lg[1].round, 2)
    assert.equal(lg[0].reason, '第一轮')
    assert.equal(lg[1].reason, '第二轮')
    assert.deepEqual(lg[0].toActors, ['userX'])
    assert.deepEqual(lg[1].toActors, ['userY'])

    await f.exec((await f.rows(host))[1], 'userY', AGREE)
    ok(await f.exec(host, 'userA', AGREE))
    assert.equal((await f.task(host.id))!.taskState, TaskState.Done)
    assert.equal((await f.ledger(host)).length, 2, '办结后账本仍在')
  })

  it('15 投影 ext.aidant 六键形状；submitted 现算；无协办行不写键', async () => {
    const f = await fx()
    const host = (await doing(f.repo, f.iid, 'review'))!
    await f.aidant(host, 'userA', ['userX', 'userY'], '协办原因', true)
    const rows = await f.rows(host)

    const p = (await f.detailExt(host.id)).aidant
    assert.ok(p, '主办行输出 ext.aidant')
    assert.deepEqual(Object.keys(p), ['active', 'round', 'total', 'submitted', 'actors', 'wait'], '投影六键锁定键序')
    assert.equal(p.active, true)
    assert.equal(p.round, 1)
    assert.equal(p.total, 2)
    assert.equal(p.submitted, 0)
    assert.equal(p.wait, true)
    assert.equal(p.actors.length, 2)
    assert.deepEqual(Object.keys(p.actors[0]), ['actor', 'taskId', 'state'])
    assert.equal(p.actors[0].actor, 'userX')
    assert.equal(p.actors[0].taskId, rows[0].id)
    assert.equal(p.actors[0].state, TaskState.Doing)

    await f.exec(rows[0], 'userX', AGREE)
    const p2 = (await f.detailExt(host.id)).aidant
    assert.equal(p2.submitted, 1)
    assert.equal(p2.active, true)

    const f2 = await fx()
    const plain = (await doing(f2.repo, f2.iid, 'review'))!
    assert.equal((await f2.detailExt(plain.id)).aidant, undefined, '无协办行不输出该投影')
  })

  // ═══ 负向：六文案＋越权＋非 DOING ═══

  it('16 负向 actorIds 必填（缺键／空数组／纯空白三档）＋零写入', async () => {
    const f = await fx()
    const host = (await doing(f.repo, f.iid, 'review'))!
    msg(await f.aidant(host, 'userA', undefined), 'actorIds 必填')
    msg(await f.aidant(host, 'userA', []), 'actorIds 必填')
    msg(await f.aidant(host, 'userA', '  ,  '), 'actorIds 必填')
    assert.equal((await f.rows(host)).length, 0, '零写入')
  })

  it('17 负向 operator 必填（缺省／全空白）', async () => {
    const f = await fx()
    const host = (await doing(f.repo, f.iid, 'review'))!
    msg(await f.aidant(host, null, 'userX'), 'operator 必填')
    msg(await f.aidant(host, '   ', 'userX'), 'operator 必填')
  })

  it('18 负向 任务不存在', async () => {
    const f = await fx()
    msg(await f.facade.flow('processTask/aidant',
      { processTaskId: '999999999', operator: 'userA', actorIds: 'userX' }), '任务不存在')
  })

  it('19 负向 越权（非名册参与人）＋零写入', async () => {
    const f = await fx()
    const host = (await doing(f.repo, f.iid, 'review'))!
    msg(await f.aidant(host, 'userZ', 'userX'), '无权限派生协办任务')
    assert.equal((await f.rows(host)).length, 0, '零写入')
    assert.equal((await f.task(host.id))!.taskState, TaskState.Doing)
  })

  it('20 名册内参与人（含加签进来的）可派生；flow.auto／flow.admin 例外放行', async () => {
    const f = await fx()
    const host = (await doing(f.repo, f.iid, 'review'))!
    ok(await f.facade.flow('processTask/addCandidate', { processTaskId: host.id, actorIds: ['userB'] }))
    ok(await f.aidant(host, 'userB', 'userX'))
    ok(await f.aidant(host, 'flow.auto', 'userY'))
    ok(await f.aidant(host, 'flow.admin', 'userZ'))
    assert.equal((await f.rows(host)).length, 3)
  })

  it('21 负向 主办行非进行中', async () => {
    const f = await fx()
    const host = (await doing(f.repo, f.iid, 'review'))!
    await f.exec(host, 'userA', AGREE)
    assert.equal((await f.task(host.id))!.taskState, TaskState.Done)
    msg(await f.aidant(host, 'userA', 'userX'), '任务非进行中，不可派生协办')
  })

  it('22 负向 该人已有未办结协办行＋零写入；已办结后可再派生', async () => {
    const f = await fx()
    const host = (await doing(f.repo, f.iid, 'review'))!
    await f.aidant(host, 'userA', 'userX')
    msg(await f.aidant(host, 'userA', 'userX'), '该人已有未办结的协办任务')
    assert.equal((await f.rows(host)).length, 1, '零写入：不重复建行')
    assert.equal((await f.ledger(host)).length, 1)

    await f.exec((await f.rows(host))[0], 'userX', AGREE)
    ok(await f.aidant(host, 'userA', 'userX'))
    assert.equal((await f.rows(host)).length, 2, '去重只认未办结')
  })

  it('23 负向 禁递归：协办行不能再派生协办＋零写入', async () => {
    const f = await fx()
    const host = (await doing(f.repo, f.iid, 'review'))!
    await f.aidant(host, 'userA', 'userX')
    const child = (await f.rows(host))[0]
    msg(await f.aidant(child, 'userX', 'userY'), '协办任务不能再派生协办')
    assert.equal((await f.rows(host)).length, 1, '零写入')
    assert.deepEqual(AD.aidantRows(await f.allTasks(), (await f.task(child.id))!), [])
  })

  // ═══ 协办行能力边界 ═══

  it('24 协办行可加/摘参与人、可被转办（走既有 actor 写腿，不造特例）', async () => {
    const f = await fx()
    const host = (await doing(f.repo, f.iid, 'review'))!
    await f.aidant(host, 'userA', 'userX')
    const cid = (await f.rows(host))[0].id

    ok(await f.facade.flow('processTask/surrogate', { processTaskId: cid, actorIds: ['userK'] }))
    assert.ok((await f.repo.findTaskActors(cid)).includes('userK'))
    ok(await f.facade.flow('processTask/addCandidate', { processTaskId: cid, actorIds: ['userL'] }))
    assert.ok((await f.repo.findTaskActors(cid)).includes('userL'))
    ok(await f.facade.flow('processTask/removeTaskActor',
      { processTaskId: cid, operator: 'userK', actorIds: ['userK'] }))
    assert.ok(!(await f.repo.findTaskActors(cid)).includes('userK'))

    ok(await f.facade.flow('processTask/transfer', {
      processTaskId: cid, operator: 'userX', fromActor: 'userX', toActor: 'userT', reason: '协办转办',
    }))
    const roster = await f.repo.findTaskActors(cid)
    assert.ok(!roster.includes('userX') && roster.includes('userT'))
    const after = (await f.task(cid))!
    assert.equal(after.id, cid, '转办不新建任务行')
    assert.equal(after.taskState, TaskState.Doing)
    assert.equal(after.taskType, TaskType.Secondary, '转办不改 task_type')

    ok(await f.exec(after, 'userT', AGREE))
    assert.equal((await f.task(host.id))!.taskState, TaskState.Doing, '转办后新办理人办结仍不驱动流程')
    assert.equal(await doing(f.repo, f.iid, 'final'), undefined)
  })

  // ═══ 回归：会签合并 ═══

  it('25 会签票齐即推进，不被协办行挡（合并判据显式排除 task_type=1）', async () => {
    const f = await fx({}, csChain())
    const members = await f.repo.findDoingTasks(f.iid)
    assert.equal(members.length, 2)
    const rowA = members.find(t => t.actorIds.includes('userA'))!
    const rowB = members.find(t => t.actorIds.includes('userB'))!

    ok(await f.aidant(rowA, 'userA', 'userX'))
    const child = AD.aidantRows(await f.allTasks(), (await f.task(rowA.id))!)[0]
    assert.equal(child.taskState, TaskState.Doing)
    assert.equal(child.taskName, 'cs')

    ok(await f.exec(rowA, 'userA', AGREE))
    ok(await f.exec(rowB, 'userB', AGREE))
    assert.equal(await f.state(), InstanceState.Done, '票齐即推进：实例办结')
    assert.equal((await f.task(child.id))!.taskState, TaskState.Abandoned, '协办行随离开节点清场')
    assert.equal((await f.repo.findDoingTasks(f.iid)).length, 0)
  })

  it('26 会签未齐时协办行办结也不得推进（推进闸＋合并判据两头都守住）', async () => {
    const f = await fx({}, csChain())
    const members = await f.repo.findDoingTasks(f.iid)
    const rowA = members.find(t => t.actorIds.includes('userA'))!
    await f.aidant(rowA, 'userA', 'userX')
    const child = AD.aidantRows(await f.allTasks(), (await f.task(rowA.id))!)[0]
    await f.exec(child, 'userX', AGREE)
    assert.equal(await f.state(), InstanceState.Doing, '协办办结不推进')
    assert.equal(await doingCount(f.repo, f.iid, 'cs'), 2)
  })

  // ═══ 回归：与征询并存（两闸各数各的行） ═══

  it('27 与征询同节点并存：两族靠 task_type 分辨，两闸各数各的行', async () => {
    const f = await fx(DC_ON)
    const host = (await doing(f.repo, f.iid, 'review'))!
    ok(await f.exec(host, 'userA', AGREE, { [KeyAddSignOperators]: ['userC'] }))
    ok(await f.aidant(host, 'userA', 'userX', undefined, true))

    const hostRow = (await f.task(host.id))!
    const all = await f.allTasks()
    assert.equal(C.memberCounts(all, hostRow)[0], 1, '征询收齐闸只数成员行')
    assert.equal(AD.countAidant(all, hostRow)[0], 1, '协办等待闸只数协办行')
    assert.equal(C.memberRows(all, hostRow).length, 1)
    assert.equal(AD.aidantRows(all, hostRow).length, 1)
    const aidantRow = AD.aidantRows(all, hostRow)[0]
    assert.equal(C.isMemberRow(all, aidantRow), false, '协办行不是征询成员行')

    // 协办先办结 ⇒ 征询闸仍拦（各数各的行），文案是征询那一族
    await f.exec(aidantRow, 'userX', AGREE)
    msg(await f.exec(hostRow, 'userA', AGREE), '节点[review]动态会签意见未收齐（已提交 0/1），不能办理')

    const member = C.memberRows(await f.allTasks(), (await f.task(host.id))!)[0]
    ok(await f.exec(member, 'userC', AGREE))
    ok(await f.exec((await f.task(host.id))!, 'userA', AGREE))
    assert.ok(await doing(f.repo, f.iid, 'final'))
  })

  it('28 反向：征询已收齐、协办未办结 ⇒ 报协办那一族文案（两闸不串味）', async () => {
    const f = await fx(DC_ON)
    const host = (await doing(f.repo, f.iid, 'review'))!
    await f.exec(host, 'userA', AGREE, { [KeyAddSignOperators]: ['userC'] })
    await f.aidant(host, 'userA', 'userX', undefined, true)
    const member = C.memberRows(await f.allTasks(), (await f.task(host.id))!)[0]
    await f.exec(member, 'userC', AGREE)
    msg(await f.exec((await f.task(host.id))!, 'userA', AGREE),
      '节点[review]协办未办结（已办结 0/1），不能办理')
  })

  it('29 征询节点上 waitCompletion=false：收齐即推进，未办结协办行清场（加签闸不被协办挡）', async () => {
    const f = await fx(DC_ON)
    const host = (await doing(f.repo, f.iid, 'review'))!
    await f.exec(host, 'userA', AGREE, { [KeyAddSignOperators]: ['userC'] })
    await f.aidant(host, 'userA', 'userX', undefined, false)
    const member = C.memberRows(await f.allTasks(), (await f.task(host.id))!)[0]
    await f.exec(member, 'userC', AGREE)
    ok(await f.exec((await f.task(host.id))!, 'userA', AGREE))
    assert.ok(await doing(f.repo, f.iid, 'final'), '缺省不等协办：收齐即推进')
    const aidantRow = AD.aidantRows(await f.allTasks(), (await f.task(host.id))!)[0]
    assert.equal((await f.task(aidantRow.id))!.taskState, TaskState.Abandoned)
  })

  // ═══ 回归：撤回清场 ═══

  it('30 已办撤回：下游 DOING 协办行一并废弃，复活行是唯一活待办', async () => {
    const f = await fx({ allowRecall: true })
    const host = (await doing(f.repo, f.iid, 'review'))!
    ok(await f.exec(host, 'userA', AGREE))
    const finalRow = (await doing(f.repo, f.iid, 'final'))!
    assert.ok(finalRow)
    ok(await f.aidant(finalRow, 'userF', 'userX'))
    const child = AD.aidantRows(await f.allTasks(), (await f.task(finalRow.id))!)[0]
    assert.equal(child.taskState, TaskState.Doing)

    const resurrected = await f.engine.recallTask(host.id, 'userA')
    assert.equal(resurrected.taskState, TaskState.Doing)
    assert.equal(resurrected.taskName, 'review')
    assert.equal((await f.task(child.id))!.taskState, TaskState.Abandoned, '下游协办行废弃')
    assert.equal((await f.task(finalRow.id))!.taskState, TaskState.Abandoned, '下游主办行废弃')
    assert.equal((await f.repo.findDoingTasks(f.iid)).length, 1, '唯一活待办')
  })

  it('31 实例撤回：DOING 协办行随整单置 WITHDRAW(30)，不留孤儿待办', async () => {
    const f = await fx()
    const host = (await doing(f.repo, f.iid, 'review'))!
    await f.aidant(host, 'userA', 'userX')
    const child = (await f.rows(host))[0]
    ok(await f.facade.flow('processInstance/withdraw', { id: f.iid, operator: 'applicant' }))
    assert.equal((await f.task(child.id))!.taskState, TaskState.Withdraw)
    assert.equal((await f.repo.findDoingTasks(f.iid)).length, 0)
  })

  // ═══ 回归：既有 actor 写腿不变 ═══

  it('32 transfer／surrogate／addCandidate 在主办行上行为不变（协办存在也不影响）', async () => {
    const f = await fx()
    const host = (await doing(f.repo, f.iid, 'review'))!
    const hid = host.id
    await f.aidant(host, 'userA', 'userX')

    ok(await f.facade.flow('processTask/surrogate', { processTaskId: hid, actorIds: ['userB'] }))
    assert.deepEqual(await f.repo.findTaskActors(hid), ['userA', 'userB'], 'surrogate 只追加原人保留')
    ok(await f.facade.flow('processTask/addCandidate', { processTaskId: hid, actorIds: ['userC'] }))
    assert.deepEqual(await f.repo.findTaskActors(hid), ['userA', 'userB', 'userC'])

    ok(await f.facade.flow('processTask/transfer', {
      processTaskId: hid, operator: 'userA', fromActor: 'userA', toActor: 'userD', reason: '转办原因',
    }))
    const roster = await f.repo.findTaskActors(hid)
    assert.ok(!roster.includes('userA') && roster.includes('userD'))
    const after = (await f.task(hid))!
    assert.equal(after.id, hid, '转办不新建任务行')
    assert.equal(Number(after.variables[KeySubmitType]), SubmitType.Transfer, '转办留痕 submitType=7')
    assert.ok(after.variables.tf_transferHistory, '转办留痕 tf_transferHistory')
    assert.equal(after.actorId, '', '转办不写 actor_id 列')
    const rows = await f.rows(after)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].taskState, TaskState.Doing, '协办行不受主办转办影响')
    ok(await f.exec(after, 'userD', AGREE))
    assert.ok(await doing(f.repo, f.iid, 'final'), '新办理人办结照常推进')
  })

  it('33 权限码复用 wf:processTask:execute（OR 规则，照 246/247 B 案惯例，不建按钮种子）', () => {
    assert.deepEqual(permissionCodes('processTask/aidant'), ['wf:processTask:execute'])
    assert.deepEqual(ACTION_PERMISSION_OR_RULES['processTask/aidant'], ['wf:processTask:execute'])
    // 哨兵：没进表的 action 仍走默认派生
    assert.deepEqual(permissionCodes('processTask/transfer'), ['wf:processTask:transfer'])
  })

  it('34 节点级 taskType=1 仍解析期禁配（issues/252 不因本轮运行期派生而放宽）', async () => {
    const f = await fx()
    const def = registerFlowJson(f.repo, chain({ taskType: 1 }))
    await assert.rejects(
      () => f.engine.startProcessInstanceById(def.id, 'applicant', {}),
      /不允许配置协办任务类型/,
    )
  })
})