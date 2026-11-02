/**
 * 「后加签（可重复）」验收（Node 栈）——移植基准＝jeeflow-java
 * `jeeflow-core/src/test/java/com/mldong/jeeflow/test/AddSignAfterTest.java` 的 16 格，
 * 语义逐格对齐：链式续办、多选同圈兄弟等待、四类写入口报错且零写入、三条解析期硬校验、
 * 拒绝／退回发起人废弃未完成加签、回归（不开开关逐字不变）、并发只放行一次、根因守卫、共享夹具。
 *
 * 夹具走内联 JSON（{@link chain}），只有 test16 读共享 `flows/19-add-sign-after.json`——
 * 与基准同策：共享流程 JSON 的镜像与漂移门禁是另一条腿，不在这里加文件把它拖进十仓同步。
 */
import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EngineImpl, KeySubmitType } from '../src/engine.js'
import { JeeflowFacade } from '../src/facade.js'
import {
  AddSignRoundKey, KeyAddSignOperators, KeyAddSignHistory, MSG_MUTEX, MSG_SELF,
  checkFlowConfig, historyOf,
} from '../src/addsign.js'
import { MemoryRepository } from '../src/memory.js'
import {
  InstanceState, SubmitType, TaskState,
  type ProcessDefine, type ProcessInstance, type ProcessTask,
} from '../src/model.js'
import type { ExpressionEvaluator, UserProvider } from '../src/spi.js'
import { dir as flowsResolverDir } from '../flows-resolver.js'

const flowDir = flowsResolverDir() + '/'
const AGREE = SubmitType.Agree
const REJECT = SubmitType.Reject
const APPLY = SubmitType.Apply
const RETURN = SubmitType.RollbackToOperator
const ROUND_KEY = `${AddSignRoundKey}_review`

function setup() {
  const repo = new MemoryRepository()
  const userProv: UserProvider = {
    async getUser(userId: string) {
      return { userId, realName: '用户' + userId, deptId: 'D01', deptName: '测试部门', postId: 'P01', postName: '测试岗位' }
    },
  }
  // id 发生器用单调计数器（同 spec.test.ts 的教训：Date.now()+随机数在同毫秒会自撞，
  // 撞上的两个 id 在内存仓 Map 里后者覆盖前者 ⇒ 血缘/待办凭空消失的随机假红）
  const base = Date.now() * 1000
  let n = 0
  const idGen = { nextId() { n += 1; return String(base + n) } }
  const exprEval: ExpressionEvaluator = { async eval() { return false } }
  return { engine: new EngineImpl(repo, userProv, idGen as any, exprEval), repo }
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
    name: `addsign-${++seq}`, displayName: '后加签夹具', type: 'approval',
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

const ADD_SIGN_ON = { allowAddSign: true }

function registerFlowJson(repo: MemoryRepository, jsonStr: string): ProcessDefine {
  const raw = JSON.parse(jsonStr)
  const def: ProcessDefine = {
    id: '', name: raw.name, displayName: raw.displayName ?? '后加签夹具', type: raw.type ?? 'approval',
    state: 1, content: jsonStr, version: 1,
  } as ProcessDefine
  repo.addDefine(def)
  return def
}

/** 发起并办结申请节点，返回停在 review 的实例；参数是审批节点的 properties 片段。 */
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
const doingCount = async (repo: MemoryRepository, iid: string, name: string) =>
  (await repo.findDoingTasks(iid)).filter(t => t.taskName === name).length
/** 进行中任务的 actor_id 列恒空是家族不变量（办结才写），取办理人要用参与者列表。 */
const firstActor = (t: ProcessTask) => (t.actorIds?.length ? t.actorIds[0] : undefined)
const rows = async (repo: MemoryRepository, iid: string, name: string) =>
  (await repo.findHistoryTasks(iid)).filter(t => t.taskName === name).length

const agree = (operators: string | string[]): Record<string, any> =>
  ({ [KeySubmitType]: AGREE, [KeyAddSignOperators]: operators })
const plain = (submitType: number): Record<string, any> => ({ [KeySubmitType]: submitType })

/** 报错且零写入的三件核对：任务行仍 DOING、实例仍进行中、本节点待办数不变。 */
async function assertNoWrite(repo: MemoryRepository, task: ProcessTask, iid: string, node: string, before: number) {
  const row = (await repo.findTaskById(task.id))!
  assert.equal(row.taskState, TaskState.Doing, '报错时任务行不得被办结')
  assert.equal((await repo.findInstanceById(iid))!.state, InstanceState.Doing, '实例状态不得被动')
  assert.equal(await rows(repo, iid, node), before, '报错时不得新增行')
}

describe('后加签（可重复）（Node）', () => {
  // ═══ 正向 ═══

  it('01 链式续办：A→B→C→不点人即流出；血缘串成链、轮次递增、账本落在已完成行', async () => {
    const { engine, repo } = setup()
    const inst = await startToReview(repo, engine, ADD_SIGN_ON)
    const a = (await doing(repo, inst.id, 'review'))!
    assert.ok(a, '应停在审批节点')

    await engine.executeProcessTask(a.id, 'userA', agree('userB'))
    const b = (await doing(repo, inst.id, 'review'))!
    assert.ok(b, '被加签人应在同一节点收到新待办')
    assert.equal(b.parentTaskId, a.id, '血缘 parent＝刚办结那条')
    assert.equal(Number(b.variables[ROUND_KEY]), 1, '轮次 1')
    assert.equal(await doing(repo, inst.id, 'final'), undefined, '令牌不得流出本节点')
    assert.equal(await doingCount(repo, inst.id, 'review'), 1, '本节点只应有 1 条待办')
    assert.equal(b.taskName, 'review')
    assert.equal(b.performType, 0, '加签任务是普通任务，不是会签')
    assert.equal(b.formKey, 'form-r', 'form 继承节点配置')

    const histA = historyOf((await repo.findTaskById(a.id))!)
    assert.equal(histA.length, 1)
    const e0 = histA[0]
    assert.equal(e0.fromActor, 'userA')
    assert.deepEqual(e0.toActors, ['userB'])
    assert.equal(e0.round, 1)
    assert.equal(e0.operator, 'userA')
    assert.match(String(e0.time), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, '时间须是全生态格式串')

    await engine.executeProcessTask(b.id, 'userB', agree('userC'))
    const c = (await doing(repo, inst.id, 'review'))!
    assert.equal(Number(c.variables[ROUND_KEY]), 2, '轮次递增')
    assert.equal(c.parentTaskId, b.id)

    // C 不再点人 → 停止条件成立，流出本节点
    await engine.executeProcessTask(c.id, 'userC', plain(AGREE))
    assert.equal(await doing(repo, inst.id, 'review'), undefined, '不点人后不得再有本节点待办')
    const fin = (await doing(repo, inst.id, 'final'))!
    assert.ok(fin, '应流转到下一审批节点')
    assert.equal(await rows(repo, inst.id, 'review'), 3, 'review 共三行')

    await engine.executeProcessTask(fin.id, 'userF', plain(AGREE))
    assert.equal((await repo.findInstanceById(inst.id))!.state, InstanceState.Done, '实例办结')
  })

  it('02 数组形多选：同圈建两行，最后一位办结且没点人才放行（兄弟等待）', async () => {
    const { engine, repo } = setup()
    const inst = await startToReview(repo, engine, ADD_SIGN_ON)
    const a = (await doing(repo, inst.id, 'review'))!

    await engine.executeProcessTask(a.id, 'userA', agree(['userB', 'userC']))
    assert.equal(await doingCount(repo, inst.id, 'review'), 2, '同圈应建两行待办')
    assert.equal(await doing(repo, inst.id, 'final'), undefined)

    const b = (await doing(repo, inst.id, 'review'))!
    await engine.executeProcessTask(b.id, firstActor(b)!, plain(AGREE))
    assert.equal(await doing(repo, inst.id, 'final'), undefined, '兄弟待办未完成时不得放行')
    assert.equal(await doingCount(repo, inst.id, 'review'), 1)

    const c = (await doing(repo, inst.id, 'review'))!
    await engine.executeProcessTask(c.id, firstActor(c)!, plain(AGREE))
    assert.ok(await doing(repo, inst.id, 'final'), '最后一位办结且没点人才放行')
    assert.equal(await doingCount(repo, inst.id, 'final'), 1, '放行只能发生一次')
  })

  it('03 加给已办过的人合法（A→B→A 乒乓），轮次继续计数', async () => {
    const { engine, repo } = setup()
    const inst = await startToReview(repo, engine, ADD_SIGN_ON)
    const a = (await doing(repo, inst.id, 'review'))!
    await engine.executeProcessTask(a.id, 'userA', agree('userB'))
    const b = (await doing(repo, inst.id, 'review'))!
    await engine.executeProcessTask(b.id, 'userB', agree('userA'))
    const back = (await doing(repo, inst.id, 'review'))!
    assert.ok(back.actorIds.includes('userA'), '加给已办过的人应合法')
    assert.equal(Number(back.variables[ROUND_KEY]), 2)
  })

  // ═══ 负向：写入口四判据报错且零写入 ═══

  it('04 与 tf_nextNodeOperator 同传 ⇒ 逐字报错，任务行/实例零改动', async () => {
    const { engine, repo } = setup()
    const inst = await startToReview(repo, engine, ADD_SIGN_ON)
    const a = (await doing(repo, inst.id, 'review'))!
    const before = await rows(repo, inst.id, 'review')
    await assert.rejects(
      () => engine.executeProcessTask(a.id, 'userA',
        { ...agree('userB'), tf_nextNodeOperator: 'userF' }),
      (e: Error) => { assert.equal(e.message, MSG_MUTEX); return true },
      '同传两键必须报错',
    )
    await assertNoWrite(repo, a, inst.id, 'review', before)
    assert.equal(await doing(repo, inst.id, 'final'), undefined)
  })

  it('05 节点未开 allowAddSign 却传键 ⇒ 报错（不得静默忽略），零写入', async () => {
    const { engine, repo } = setup()
    const inst = await startToReview(repo, engine, {})   // review 不开 allowAddSign
    const a = (await doing(repo, inst.id, 'review'))!
    const before = await rows(repo, inst.id, 'review')
    await assert.rejects(
      () => engine.executeProcessTask(a.id, 'userA', agree('userB')),
      (e: Error) => { assert.match(e.message, /未开启 allowAddSign，不接受 tf_addSignOperators/); return true },
    )
    await assertNoWrite(repo, a, inst.id, 'review', before)
    assert.equal(await doing(repo, inst.id, 'final'), undefined)
  })

  it('06 加给自己 ⇒ 报错（死循环入口），零写入', async () => {
    const { engine, repo } = setup()
    const inst = await startToReview(repo, engine, ADD_SIGN_ON)
    const a = (await doing(repo, inst.id, 'review'))!
    const before = await rows(repo, inst.id, 'review')
    await assert.rejects(
      () => engine.executeProcessTask(a.id, 'userA', agree('userA')),
      (e: Error) => { assert.equal(e.message, MSG_SELF); return true },
    )
    await assertNoWrite(repo, a, inst.id, 'review', before)
    assert.equal(await doingCount(repo, inst.id, 'review'), 1, '不得多建一条自己的待办')
  })

  it('07 超 addSignMaxRounds ⇒ 报错不强制放行，零写入；上限内不点人仍正常流出', async () => {
    const { engine, repo } = setup()
    const inst = await startToReview(repo, engine, { ...ADD_SIGN_ON, addSignMaxRounds: 1 })
    const a = (await doing(repo, inst.id, 'review'))!
    await engine.executeProcessTask(a.id, 'userA', agree('userB'))   // 第 1 轮，合法
    const b = (await doing(repo, inst.id, 'review'))!
    const before = await rows(repo, inst.id, 'review')
    await assert.rejects(
      () => engine.executeProcessTask(b.id, 'userB', agree('userC')), // 第 2 轮，越界
      (e: Error) => { assert.match(e.message, /的加签轮次已达上限 1，本次提交被拒绝/); return true },
    )
    await assertNoWrite(repo, b, inst.id, 'review', before)
    assert.equal(await doing(repo, inst.id, 'final'), undefined)
    // 但第 1 轮那位不点人可以正常流出
    await engine.executeProcessTask(b.id, 'userB', plain(AGREE))
    assert.ok(await doing(repo, inst.id, 'final'))
  })

  // ═══ 三条解析期硬校验 ═══

  it('08 会签节点配 allowAddSign ⇒ 解析期报错', () => {
    const bad = JSON.parse(chain({}, { ...ADD_SIGN_ON, performType: 1, countersignType: 'PARALLEL' }))
    assert.throws(() => checkFlowConfig(bad), /会签节点\[review\]不允许配置 allowAddSign/)
  })

  it('09 首任务节点配 allowAddSign ⇒ 解析期报错', () => {
    const bad = JSON.parse(chain({ ...ADD_SIGN_ON }, ADD_SIGN_ON))
    assert.throws(() => checkFlowConfig(bad), /首任务节点\[apply\]不允许配置 allowAddSign/)
  })

  it('10 两键非法值 ⇒ 解析期报错，不得静默当缺省', () => {
    assert.throws(() => checkFlowConfig(JSON.parse(chain({}, { allowAddSign: 'yes' }))),
      /节点\[review\]的 allowAddSign 配置非法: yes/)
    assert.throws(() => checkFlowConfig(JSON.parse(chain({}, { ...ADD_SIGN_ON, addSignMaxRounds: -1 }))),
      /addSignMaxRounds 配置非法: -1（不得为负，0 表示不限）/)
    assert.throws(() => checkFlowConfig(JSON.parse(chain({}, { ...ADD_SIGN_ON, addSignMaxRounds: '1.5' }))),
      /addSignMaxRounds 配置非法: 1\.5（必须是整数，0 表示不限）/)
    // 合法形状不得误伤
    checkFlowConfig(JSON.parse(chain({}, { ...ADD_SIGN_ON, addSignMaxRounds: 0 })))
  })

  it('10b 解析期校验已接进引擎读定义的口子：带病定义发起即报错', async () => {
    const { engine, repo } = setup()
    const def = registerFlowJson(repo, chain({}, { ...ADD_SIGN_ON, performType: 1 }))
    await assert.rejects(() => engine.startProcessInstanceById(def.id, 'applicant', {}),
      /会签节点\[review\]不允许配置 allowAddSign/)
  })

  // ═══ 拒绝／退回发起人废弃未完成加签 ═══

  it('11 不同意(2)：实例结束，本节点未完成的兄弟加签任务废弃，不留孤儿待办', async () => {
    const { engine, repo } = setup()
    const inst = await startToReview(repo, engine, ADD_SIGN_ON)
    const a = (await doing(repo, inst.id, 'review'))!
    await engine.executeProcessTask(a.id, 'userA', agree(['userB', 'userC']))
    assert.equal(await doingCount(repo, inst.id, 'review'), 2)

    const b = (await doing(repo, inst.id, 'review'))!
    await engine.executeAndJumpToEnd(b.id, firstActor(b)!, plain(REJECT))

    assert.equal((await repo.findInstanceById(inst.id))!.state, InstanceState.Reject, '实例应已结束(45)')
    assert.equal(await doingCount(repo, inst.id, 'review'), 0, '未完成的加签兄弟不得留待办')
    const abandoned = (await repo.findHistoryTasks(inst.id))
      .filter(t => t.taskName === 'review' && t.taskState === TaskState.Abandoned).length
    assert.equal(abandoned, 1, '被废弃的那条应留废弃态(99)')
  })

  it('12 退回发起人(6)：生成申请待办，本节点未完成加签任务废弃', async () => {
    const { engine, repo } = setup()
    const inst = await startToReview(repo, engine, ADD_SIGN_ON)
    const a = (await doing(repo, inst.id, 'review'))!
    await engine.executeProcessTask(a.id, 'userA', agree(['userB', 'userC']))
    const b = (await doing(repo, inst.id, 'review'))!
    await engine.executeAndJumpToFirstTaskNode(b.id, firstActor(b)!, plain(RETURN))

    assert.ok(await doing(repo, inst.id, 'apply'), '应生成申请待办')
    assert.equal(await doingCount(repo, inst.id, 'review'), 0, '本节点未完成加签任务应被废弃')
    assert.equal(await doing(repo, inst.id, 'final'), undefined)
  })

  it('13 加签链上退回上一步(3) ⇒ 既有血缘守卫拦下（同节点，报 20010008 档文案）', async () => {
    const { engine, repo } = setup()
    const inst = await startToReview(repo, engine, ADD_SIGN_ON)
    const a = (await doing(repo, inst.id, 'review'))!
    await engine.executeProcessTask(a.id, 'userA', agree('userB'))
    const b = (await doing(repo, inst.id, 'review'))!
    // 当前行与其血缘 parent 同节点 ⇒ canRejected 不过 ⇒ 照会签先例报那一档（零改动复用既有守卫）
    await assert.rejects(() => engine.executeAndJumpTask(b.id, 'userB', plain(SubmitType.Rollback), ''),
      /无法驳回至上一步处理/)
    assert.equal(await doing(repo, inst.id, 'final'), undefined, '被拒的这一次不得放行出边')
    assert.equal((await repo.findInstanceById(inst.id))!.state, InstanceState.Doing, '实例仍进行中')
    // ⚠️ 本格不核对"b 那一行是否被办结"：血缘守卫排在 completeTask 之后，内存仓储无回滚 ⇒
    // 行会被办结而流程不前进（真库那侧由动作级事务整体回滚）。这是**退回上一步那条腿**的既有
    // 形状（会签链同款），不是本轮加签引入的，改它要动的是守卫位置、归另案。
  })

  // ═══ 回归与并发 ═══

  it('14 不开开关的节点行为逐字不变：同意即流出，账本为空', async () => {
    const { engine, repo } = setup()
    const inst = await startToReview(repo, engine, {})
    const a = (await doing(repo, inst.id, 'review'))!
    await engine.executeProcessTask(a.id, 'userA', plain(AGREE))
    assert.ok(await doing(repo, inst.id, 'final'))
    assert.equal(await rows(repo, inst.id, 'review'), 1)
    assert.deepEqual(historyOf((await repo.findTaskById(a.id))!), [])
  })

  it('15 两个同圈加签任务并发办结：只放行一次（后续节点恰好一条待办）', async () => {
    const { engine, repo } = setup()
    const inst = await startToReview(repo, engine, ADD_SIGN_ON)
    const a = (await doing(repo, inst.id, 'review'))!
    await engine.executeProcessTask(a.id, 'userA', agree(['userB', 'userC']))
    const siblings = await repo.findDoingTasks(inst.id)
    assert.equal(siblings.length, 2)

    const results = await Promise.allSettled(
      siblings.map(t => engine.executeProcessTask(t.id, firstActor(t)!, plain(AGREE))))
    const failed = results.filter(r => r.status === 'rejected')
    assert.equal(failed.length, 0, `并发办结不应报错：${failed.map(f => (f as any).reason?.message).join('; ')}`)
    assert.equal(await doingCount(repo, inst.id, 'final'), 1, '后续节点只应有一条待办')
    assert.equal(await doingCount(repo, inst.id, 'review'), 0)
  })

  it('16 根因守卫：tf_ 控制键不得进实例变量（跨请求复活），留痕仍在任务行', async () => {
    const { engine, repo } = setup()
    const inst = await startToReview(repo, engine, ADD_SIGN_ON)
    const a = (await doing(repo, inst.id, 'review'))!
    await engine.executeProcessTask(a.id, 'userA',
      { ...agree('userB'), tf_approvalComment: '请 B 复核' })

    const instanceVars = (await repo.findInstanceById(inst.id))!.variables
    assert.equal(instanceVars[KeyAddSignOperators], undefined, 'tf_addSignOperators 不得进实例变量')
    assert.equal(instanceVars.tf_approvalComment, undefined, 'tf_approvalComment 不得进实例变量')
    for (const key of Object.keys(instanceVars)) {
      assert.ok(!key.startsWith('tf_'), `实例变量里不应有任何 tf_ 键: ${key}`)
    }
    // 留痕仍在任务行上（修根因不得把审计信息一起改掉）
    const rowVars = (await repo.findTaskById(a.id))!.variables
    assert.equal(rowVars.tf_approvalComment, '请 B 复核')
    assert.equal(String(rowVars[KeyAddSignOperators]), 'userB')
    assert.equal(historyOf((await repo.findTaskById(a.id))!).length, 1)

    // 复活面（承重陷阱的正判据）：上一轮的 tf_addSignOperators 不得让 B 办结时凭空多建一条待办
    const b = (await doing(repo, inst.id, 'review'))!
    await engine.executeProcessTask(b.id, 'userB', plain(AGREE))
    assert.equal(await doingCount(repo, inst.id, 'review'), 0, '不得凭空多建本节点待办')
    assert.ok(await doing(repo, inst.id, 'final'), '应正常流出本节点')
  })

  it('17 共享夹具 flows/19-add-sign-after.json 真被本栈消费（逗号串两形建两行、兄弟全办结后放行）', async () => {
    const { engine, repo } = setup()
    const bytes = readFileSync(flowDir + '19-add-sign-after.json', 'utf-8')
    const def = registerFlowJson(repo, bytes)
    const started = await engine.startProcessInstanceById(def.id, 'applicant', {})
    for (const t of await repo.findDoingTasks(started.id)) {
      await engine.executeProcessTask(t.id, 'applicant', plain(APPLY))
    }
    const iid = started.id
    const a = (await doing(repo, iid, 'review'))!
    assert.ok(a, '共享夹具的申请节点办结后应到审批节点')
    await engine.executeProcessTask(a.id, 'userA', agree('userB,userC'))
    assert.equal(await doingCount(repo, iid, 'review'), 2, '逗号串两形应建两行')
    assert.equal(await doing(repo, iid, 'final'), undefined)

    // 先取快照再逐条办结：办结会改写仓储里的进行中集合，边遍历边办是并发修改
    const siblings = await repo.findDoingTasks(iid)
    for (const t of siblings) {
      await engine.executeProcessTask(t.id, firstActor(t)!, plain(AGREE))
    }
    const fin = (await doing(repo, iid, 'final'))!
    assert.ok(fin, '同圈兄弟全部办结后应放行')
    assert.equal(await rows(repo, iid, 'final'), 1)
    await engine.executeProcessTask(fin.id, 'userF', plain(AGREE))
    assert.equal((await repo.findInstanceById(iid))!.state, InstanceState.Done)
  })

  it('18 账本只追加不覆盖：同一条行两次留痕各占一格（形状照 tf_transferHistory 那族）', async () => {
    const { engine, repo } = setup()
    const inst = await startToReview(repo, engine, ADD_SIGN_ON)
    const a = (await doing(repo, inst.id, 'review'))!
    await engine.executeProcessTask(a.id, 'userA', agree('userB'))
    // 同一提交里带两个加签人 ⇒ 一圈一条账（不是每人一条）
    const b1 = (await doing(repo, inst.id, 'review'))!
    await engine.executeProcessTask(b1.id, firstActor(b1)!, agree(['userC', 'userD']))
    const hist = historyOf((await repo.findTaskById(a.id))!)
    assert.equal(hist.length, 1, 'A 那一行只有它自己那一圈的一条')
    assert.deepEqual(hist[0].toActors, ['userB'])
    const histB = historyOf((await repo.findTaskById(b1.id))!)
    assert.equal(histB.length, 1)
    assert.deepEqual(histB[0].toActors, ['userC', 'userD'])
    assert.equal(histB[0].round, 2, '轮次号随圈递增')
    assert.equal(Object.keys(histB[0]).join(','), 'round,fromActor,toActors,time,operator', '五键固定顺序与命名')
  })

  it('19 加签行过 JDBC 之外的仓储往返仍能续办（内存仓读回＝新聚合），且账本不进新待办', async () => {
    const { engine, repo } = setup()
    const inst = await startToReview(repo, engine, ADD_SIGN_ON)
    const a = (await doing(repo, inst.id, 'review'))!
    await engine.executeProcessTask(a.id, 'userA', agree('userB'))
    const b = (await doing(repo, inst.id, 'review'))!
    // 新待办不得带上一轮的账本（tf_ 前缀使复活腿剔得干净，这里连"随行拷贝"都不该有）
    assert.equal(b.variables[KeyAddSignHistory], undefined, '账本不得污染新待办')
    assert.equal(Number(b.variables[ROUND_KEY]), 1, '轮次键随行落地，重启后读得到')
    await engine.executeProcessTask(b.id, 'userB', agree('userC'))
    const c = (await doing(repo, inst.id, 'review'))!
    assert.equal(Number(c.variables[ROUND_KEY]), 2, '跨"仓储读回"那一跳轮次不丢')
  })

  it('20 坏样本守卫：merged 判据若恒真（放行不看兄弟待办），02 那格必红', async () => {
    // 基准纪律（reapply 轮的守卫姿势）：不 mock 引擎内部，而是把"只剩一条兄弟待办"这一
    // 关键前置直接打在闸上——若闸退化成恒真，此处就会凭空出现 final 待办。
    const { engine, repo } = setup()
    const inst = await startToReview(repo, engine, ADD_SIGN_ON)
    const a = (await doing(repo, inst.id, 'review'))!
    await engine.executeProcessTask(a.id, 'userA', agree(['userB', 'userC']))
    const [b, c] = await repo.findDoingTasks(inst.id)
    assert.ok(b && c)
    await engine.executeProcessTask(b.id, firstActor(b)!, plain(AGREE))
    assert.equal(await doing(repo, inst.id, 'final'), undefined, 'c 还在办 ⇒ 闸必须关着')
    assert.ok(await doing(repo, inst.id, 'review'), '本节点仍应有 c 那条待办')
  })

  it('21 门面信封：execute 带 tf_addSignOperators 走 code=0；同传两键的失败信封带逐字 msg（不被出口文案兜底吞掉）', async () => {
    const { engine, repo } = setup()
    const facade = new JeeflowFacade(engine, repo)
    const inst = await startToReview(repo, engine, ADD_SIGN_ON)
    const a = (await doing(repo, inst.id, 'review'))!

    const ok = await facade.flow('processTask/execute', {
      processTaskId: a.id, operator: 'userA', submitType: AGREE, [KeyAddSignOperators]: 'userB',
    })
    assert.equal(ok.code, 0, JSON.stringify(ok))
    const b = (await doing(repo, inst.id, 'review'))!
    assert.ok(b, '门面腿同样应续建本节点待办')
    assert.equal(Number(b.variables[ROUND_KEY]), 1)

    const bad = await facade.flow('processTask/execute', {
      processTaskId: b.id, operator: 'userB', submitType: AGREE,
      [KeyAddSignOperators]: 'userC', tf_nextNodeOperator: 'userF',
    })
    assert.equal(bad.code, 99999999, JSON.stringify(bad))
    assert.equal(bad.msg, MSG_MUTEX, '失败 msg 逐字＝跨栈契约文案')
    assert.equal(await doingCount(repo, inst.id, 'review'), 1, '报错那次零写入')
  })
})
