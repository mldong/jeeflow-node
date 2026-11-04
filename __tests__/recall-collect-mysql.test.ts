/**
 * issues/246 已办撤回 ＋ issues/247 动态会签 —— 真库（160 MySQL）腿（T1）。
 *
 * 为什么要单独一条真库腿（内存仓那两条已覆盖判据面）：这一档钉的是**落库形状**——
 * ① 撤回的复活行连同名册真的写进了 `wf_process_task` ＋ `wf_process_task_actor`
 *    （`findTaskById` 从参与者表水合 `actorIds`，参与人判据在真库走得通）；
 * ② 原 FINISHED 行**不改写**、`tf_recallHistory` 账本随 `variable` 列 JSON 往返；
 * ③ 征询成员行的 `task_parent_id`／轮次戳／`tf_addSignReason` 落库可读（投影与闸门都靠它们现算）；
 * ④ 闸门报错那一次经**动作级事务**整笔回滚，真库查不到半行。
 *
 * 用法：node --import tsx --test __tests__/recall-collect-mysql.test.ts（连 160，与 tx-tier 同纪律）
 * 固定 define id 950004（本文件专用；与 jdbc.test.ts 的 900004/910004、tx-tier 的 920004 不冲突）。
 * id 生成用槽位 4（jdbc.test.ts 用槽位 2、tx-tier 用 0，见该文件 STACK_SEQ 注释）⇒ 并发跑同库不撞主键。
 */
import { after, before, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import mysql from 'mysql2/promise'
import { EngineImpl, KeySubmitType } from '../src/engine.js'
import { JdbcRepository } from '../src/jdbc/index.js'
import { MysqlAdapter } from '../src/jdbc/mysql.js'
import { JeeflowFacade } from '../src/facade.js'
import { KeyAddSignOperators } from '../src/addsign.js'
import { KeyAddSignReason } from '../src/collect.js'
import { KeyRecallHistory } from '../src/recall.js'
import { msgPending } from '../src/collect.js'
import { InstanceState, SubmitType, TaskState, type ProcessTask } from '../src/model.js'
import { EventType, type ProcessEvent } from '../src/extensions.js'
import type { IDGenerator, UserProvider } from '../src/spi.js'

const DB_HOST = process.env.JEFFLOW_DB_HOST ?? '192.168.1.160'
const DB_PORT = Number(process.env.JEFFLOW_DB_PORT ?? 3306)
const DB_USER = process.env.JEFFLOW_DB_USER ?? 'root'
const DB_PWD = process.env.JEFFLOW_DB_PWD ?? '8Eli#gr#AUk'
const DEFINE_ID = '950004'
const SCHEMA_DIR = 'tests/schema/'

const pool: any = mysql.createPool({
  host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PWD,
  database: 'jeeflow', charset: 'utf8mb4', connectionLimit: 5,
  supportBigNumbers: true, bigNumberStrings: true,
})
// 独立取证池：判"报错那次有没有留下半行"必须走与动作事务无关的第二条连接
const pool2: any = mysql.createPool({
  host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PWD,
  database: 'jeeflow', charset: 'utf8mb4', connectionLimit: 2,
  supportBigNumbers: true, bigNumberStrings: true,
})

const userProv: UserProvider = {
  async getUser(userId) {
    return { userId, realName: userId, deptId: 'D01', deptName: '部门', postId: 'P01', postName: '岗位' }
  },
}

class SeqIDGen implements IDGenerator {
  private base = Date.now() * 4000 + 4 * 1000
  private n = 0
  nextId(): string { this.n += 1; return String(this.base + this.n) }
}

async function q(p: any, sql: string, args: any[] = []): Promise<any[]> {
  const [rows] = await p.execute(sql, args)
  return rows as any[]
}

// ─── 夹具（内联 JSON，与内存仓那两条腿同形状，不碰共享 flows/ 目录） ───────────

const nodeOf = (id: string, type: string, props: Record<string, any>, text: string) =>
  ({ id, type, x: 0, y: 0, properties: props, text: { value: text } })
const edgeOf = (id: string, from: string, to: string) =>
  ({ id, type: 'snaker:transition', sourceNodeId: from, targetNodeId: to, properties: {} })

let seq = 0
function chain(reviewProps: Record<string, any>): string {
  return JSON.stringify({
    name: `rc246${++seq}`, displayName: '撤回与征询真库夹具', type: 'approval',
    nodes: [
      nodeOf('start', 'snaker:start', {}, '开始'),
      nodeOf('apply', 'snaker:task', { form: 'apply-form', assignee: 'applicant', taskType: 0, performType: 0 }, '发起申请'),
      nodeOf('review', 'snaker:task', { form: 'form-r', assignee: 'userA', taskType: 0, performType: 0, ...reviewProps }, '审批'),
      nodeOf('final', 'snaker:task', { form: 'form-f', assignee: 'userF', taskType: 0, performType: 0 }, '终审'),
      nodeOf('archive', 'snaker:task', { form: 'form-a', assignee: 'userG', taskType: 0, performType: 0 }, '归档'),
      nodeOf('end', 'snaker:end', {}, '结束'),
    ],
    edges: [edgeOf('e1', 'start', 'apply'), edgeOf('e2', 'apply', 'review'),
      edgeOf('e3', 'review', 'final'), edgeOf('e4', 'final', 'archive'), edgeOf('e5', 'archive', 'end')],
  })
}

async function putDefine(jsonStr: string): Promise<void> {
  const raw = JSON.parse(jsonStr)
  const conn = await pool.getConnection()
  try {
    await conn.execute('DELETE FROM wf_process_define WHERE id = ?', [DEFINE_ID])
    const now = new Date()
    await conn.execute(
      'INSERT INTO wf_process_define (id, name, display_name, type, state, content, version, ' +
      'create_time, create_user, update_time, update_user) VALUES (?, ?, ?, ?, 1, ?, 1, ?, ?, ?, ?)',
      [DEFINE_ID, raw.name, raw.displayName, raw.type, jsonStr, now, 'rc', now, 'rc'])
  } finally {
    conn.release()
  }
}

async function applySchema(): Promise<void> {
  const sql = readFileSync(SCHEMA_DIR + 'schema-mysql.sql', 'utf-8')
  const conn = await pool.getConnection()
  try {
    let buf = ''
    for (const line of sql.split('\n')) {
      const l = line.trim()
      if (!l || l.startsWith('--')) continue
      buf += l + ' '
      if (l.endsWith(';')) {
        await conn.execute(buf.trim().replace(/;$/, ''))
        buf = ''
      }
    }
  } finally {
    conn.release()
  }
}

async function cleanup(): Promise<void> {
  const conn = await pool.getConnection()
  try {
    await conn.execute('DELETE FROM wf_process_task_actor WHERE process_task_id IN ' +
      '(SELECT id FROM wf_process_task WHERE process_instance_id IN ' +
      '(SELECT id FROM wf_process_instance WHERE process_define_id = ?))', [DEFINE_ID])
    await conn.execute('DELETE FROM wf_process_cc_instance WHERE process_instance_id IN ' +
      '(SELECT id FROM wf_process_instance WHERE process_define_id = ?)', [DEFINE_ID])
    await conn.execute('DELETE FROM wf_process_task WHERE process_instance_id IN ' +
      '(SELECT id FROM wf_process_instance WHERE process_define_id = ?)', [DEFINE_ID])
    await conn.execute('DELETE FROM wf_process_instance WHERE process_define_id = ?', [DEFINE_ID])
    await conn.execute('DELETE FROM wf_process_define WHERE id = ?', [DEFINE_ID])
  } finally {
    conn.release()
  }
}

function makeStack() {
  const repo = new JdbcRepository(makeAdapterSafe(), new SeqIDGen())
  const engine = new EngineImpl(repo, userProv as any, new SeqIDGen(), { async eval() { return false } } as any)
  const fired: ProcessEvent[] = []
  engine.setExtensions({ listeners: [(e) => { fired.push({ ...e }) }] })
  return { repo, engine, fired, facade: new JeeflowFacade(engine, repo) }
}
function makeAdapterSafe() {
  return new MysqlAdapter(pool)
}

const doing = async (repo: any, iid: string, name: string): Promise<ProcessTask | undefined> =>
  (await repo.findDoingTasks(iid)).find((t: ProcessTask) => t.taskName === name)
const rowsOf = async (repo: any, iid: string, name: string): Promise<ProcessTask[]> =>
  (await repo.findHistoryTasks(iid)).filter((t: ProcessTask) => t.taskName === name)

async function startToReview(reviewProps: Record<string, any>) {
  const stack = makeStack()
  await putDefine(chain(reviewProps))
  const started = await stack.engine.startProcessInstanceById(DEFINE_ID, 'applicant', {})
  for (const t of await stack.repo.findDoingTasks(started.id)) {
    await stack.engine.executeProcessTask(t.id, 'applicant', { [KeySubmitType]: SubmitType.Apply })
  }
  const inst = (await stack.repo.findInstanceById(started.id))!
  return { ...stack, inst }
}

before(async () => {
  await applySchema()
  await cleanup()
})

after(async () => {
  await cleanup()
  await pool.end()
  await pool2.end()
})

describe('issues/246＋247 真库腿（160 MySQL）', () => {
  it('① 已办撤回：复活行＋名册真的落库；原行 task_state 仍是 20 且 variable 里带 tf_recallHistory', async () => {
    const { engine, repo, fired, inst } = await startToReview({ allowRecall: true, expireTime: '2h' })
    const review = (await doing(repo, inst.id, 'review'))!
    await engine.executeProcessTask(review.id, 'userA', { [KeySubmitType]: SubmitType.Agree })
    const fin = (await doing(repo, inst.id, 'final'))!
    fired.length = 0

    const res = await engine.recallTask(review.id, 'userA')
    // 复活行在库里，且名册从参与者表读得回来（判据的"按名册"那一半真走通）
    const revived = (await repo.findTaskById(res.id))!
    assert.equal(revived.taskState, TaskState.Doing)
    assert.deepEqual(revived.actorIds, ['userA'], '复活行名册落 wf_process_task_actor')
    assert.equal(String(revived.parentTaskId), String(review.parentTaskId), '血缘 parent 落库')
    assert.ok(revived.expireTime, 'expire_time 同尺落库（节点配了 2h）')
    assert.equal(await doing(repo, inst.id, 'final'), undefined, '下游行在库里也置 99')
    assert.equal((await repo.findTaskById(fin.id))!.taskState, TaskState.Abandoned)
    // 原行不改写＋账本随 variable JSON 往返
    const keep = (await repo.findTaskById(review.id))!
    assert.equal(keep.taskState, TaskState.Done, '原行仍是已完成（历史即审批记录）')
    const hist: any[] = (keep.variables as any)[KeyRecallHistory]
    assert.equal(hist.length, 1)
    assert.equal(hist[0].operator, 'userA')
    assert.equal(String(hist[0].recalledTaskId), String(res.id))
    assert.match(String(hist[0].time), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    // 直查库面（不走仓储映射）：原行那一列没被改回 10
    const [rawRow] = await q(pool2, 'SELECT task_state, operator FROM wf_process_task WHERE id = ?', [review.id])
    assert.equal(Number(rawRow.task_state), TaskState.Done)
    assert.equal(rawRow.operator, 'userA')
    // 事件：码 3 恰一次＋码 10 恰一次
    assert.equal(fired.filter(e => e.type === EventType.ProcessTaskStart).length, 1)
    assert.equal(fired.filter(e => e.type === EventType.TaskRecall).length, 1)
    assert.equal(fired.filter(e => e.type === EventType.TaskComplete).length, 0)
  })

  it('② 已办撤回负向：非参与者报错零写入；下游已办结 ⇒ 窗口逐字文案', async () => {
    const { engine, repo, facade, inst } = await startToReview({ allowRecall: true })
    const review = (await doing(repo, inst.id, 'review'))!
    await engine.executeProcessTask(review.id, 'userA', { [KeySubmitType]: SubmitType.Agree })
    const beforeRows = (await rowsOf(repo, inst.id, 'review')).length

    const noPerm = await facade.flow('processTask/recall', { processTaskId: review.id, operator: 'userZ' })
    assert.equal(noPerm.code, 99999999, JSON.stringify(noPerm))
    assert.equal(noPerm.msg, '无权限撤回该任务')
    assert.equal((await rowsOf(repo, inst.id, 'review')).length, beforeRows, '报错那次库里不得多一行')

    await engine.executeProcessTask((await doing(repo, inst.id, 'final'))!.id, 'userF',
      { [KeySubmitType]: SubmitType.Agree })
    const win = await facade.flow('processTask/recall', { processTaskId: review.id, operator: 'userA' })
    assert.equal(win.code, 99999999, JSON.stringify(win))
    assert.equal(win.msg, '任务[review]的后续节点已办理，不能撤回')
    const [cnt] = await q(pool2, 'SELECT COUNT(*) AS n FROM wf_process_task WHERE task_name = ? AND task_state = 10 ' +
      'AND process_instance_id = ?', ['review', inst.id])
    assert.equal(Number(cnt.n), 0, '窗口拦下 ⇒ 库里没有复活行')
  })

  it('③ 动态会签：成员行三戳落库、主办行未办结且账本随 variable 往返', async () => {
    const { repo, facade, inst } = await startToReview({ dynamicCountersign: true })
    const host = (await doing(repo, inst.id, 'review'))!
    const res = await facade.flow('processTask/execute', {
      processTaskId: host.id, operator: 'userA', submitType: SubmitType.Agree,
      [KeyAddSignOperators]: 'userB,userC', [KeyAddSignReason]: '请部门复核',
    })
    assert.equal(res.code, 0, JSON.stringify(res))
    assert.deepEqual(res.data.dynamicCountersign, { round: 1, total: 2, submitted: 0 })

    const hostRow = (await repo.findTaskById(host.id))!
    assert.equal(hostRow.taskState, TaskState.Doing, '主办行未办结＝征询挂起（真库可见）')
    assert.equal(Number(hostRow.variables['addSignRound_review']), 1, '主办行轮次戳落库')
    assert.equal(hostRow.variables[KeyRecallHistory], undefined, '撤回账本不串到征询档')
    const hist: any[] = hostRow.variables.tf_addSignHistory
    assert.equal(hist.length, 1)
    assert.equal(hist[0].reason, '请部门复核')
    assert.deepEqual(hist[0].toActors, ['userB', 'userC'])

    const members = (await rowsOf(repo, inst.id, 'review')).filter(t => String(t.parentTaskId) === String(host.id))
    assert.equal(members.length, 2)
    for (const m of members) {
      assert.equal(m.taskState, TaskState.Doing)
      assert.equal(Number(m.variables['addSignRound_review']), 1)
      assert.equal(m.variables[KeyAddSignReason], '请部门复核')
      assert.equal(m.performType, 0)
    }
    const [raw] = await q(pool2, 'SELECT COUNT(*) AS n FROM wf_process_task_actor a JOIN wf_process_task t ' +
      'ON a.process_task_id = t.id WHERE t.task_name = ? AND t.task_parent_id = ?', ['review', host.id])
    assert.equal(Number(raw.n), 2, '两条成员行的参与者各落一行')
  })

  it('④ 闸门逐字文案：未收齐时真库整笔回滚（第二连接查不到半行）', async () => {
    const { repo, facade, inst } = await startToReview({ dynamicCountersign: true })
    const host = (await doing(repo, inst.id, 'review'))!
    await facade.flow('processTask/execute', {
      processTaskId: host.id, operator: 'userA', submitType: SubmitType.Agree, [KeyAddSignOperators]: 'userB',
    })
    const res = await facade.flow('processTask/execute', {
      processTaskId: host.id, operator: 'userA', submitType: SubmitType.Reject,
    })
    assert.equal(res.code, 99999999, JSON.stringify(res))
    assert.equal(res.msg, msgPending('review', 0, 1))
    const [row] = await q(pool2, 'SELECT task_state FROM wf_process_task WHERE id = ?', [host.id])
    assert.equal(Number(row.task_state), TaskState.Doing, '驳回被挡 ⇒ 主办行在库里仍未办结')
    const [instRow] = await q(pool2, 'SELECT state FROM wf_process_instance WHERE id = ?', [inst.id])
    assert.equal(Number(instRow.state), InstanceState.Doing)
  })

  it('⑤ 撤回动态会签：未答行置 99、已交意见保留、投影跳过废弃行（全走真库）', async () => {
    const { repo, facade, inst } = await startToReview({ dynamicCountersign: true })
    const host = (await doing(repo, inst.id, 'review'))!
    await facade.flow('processTask/execute', {
      processTaskId: host.id, operator: 'userA', submitType: SubmitType.Agree, [KeyAddSignOperators]: 'userB,userC',
    })
    // 成员行按名册取（doing() 取 id 最小行＝主办行；fallback 再调一次同函数是同一行——真库按 id 升序必踩）
    const bRow = (await repo.findDoingTasks(inst.id))
      .find((t: ProcessTask) => t.taskName === 'review' && t.actorIds.includes('userB'))!
    assert.equal((await facade.flow('processTask/execute', {
      processTaskId: bRow.id, operator: 'userB', submitType: SubmitType.Agree,
    })).code, 0)
    const rev = await facade.flow('processTask/revokeDynamicCountersign',
      { processTaskId: host.id, operator: 'userA', reason: '线下已收' })
    assert.equal(rev.code, 0, JSON.stringify(rev))
    assert.deepEqual(rev.data, { revoked: 1, actors: ['userC'] })

    const tasks = await rowsOf(repo, inst.id, 'review')
    assert.equal(tasks.filter(t => t.taskState === TaskState.Abandoned).length, 1, '未答那条置 99')
    assert.equal(tasks.filter(t => t.taskState === TaskState.Done).length, 1, '已交意见行保留（审计凭证不动）')
    const hostRow = (await repo.findTaskById(host.id))!
    const h: any[] = hostRow.variables.tf_addSignHistory
    assert.equal(h.length, 2)
    assert.equal(h[1].revoked, true)
    assert.equal(h[1].round, 1, '撤回不推进轮次')
    assert.equal(h[1].reason, '线下已收')

    const detail = await facade.flow('processTask/detail', { id: host.id, operator: 'userA' })
    assert.equal(detail.code, 0, JSON.stringify(detail))
    assert.equal(detail.data.ext.dynamicCountersign.total, 1, '99 行不进投影')
    assert.equal(detail.data.ext.dynamicCountersign.submitted, 1)
    assert.equal(detail.data.ext.dynamicCountersign.active, false)

    // 闸门自然恢复 ⇒ 主办拍板能走完（真库）
    const ok = await facade.flow('processTask/execute', {
      processTaskId: host.id, operator: 'userA', submitType: SubmitType.Agree,
    })
    assert.equal(ok.code, 0, JSON.stringify(ok))
    assert.ok(await doing(repo, inst.id, 'final'), '主办拍板后流出本节点')
  })

  it('⑥ 已办撤回把后加签行一并清场（两特性交叉那一格，真库落库形状）', async () => {
    // allowRecall 与 allowAddSign 同开合法（只与 dynamicCountersign 互斥）——撤回时那条
    // 未办的后加签行是原行的下游 DOING ⇒ 连带废弃
    const { repo, facade, engine, inst } = await startToReview({ allowRecall: true, allowAddSign: true })
    const a = (await doing(repo, inst.id, 'review'))!
    const launch = await facade.flow('processTask/execute', {
      processTaskId: a.id, operator: 'userA', submitType: SubmitType.Agree, [KeyAddSignOperators]: 'userB',
    })
    assert.equal(launch.code, 0, JSON.stringify(launch))
    const b = (await doing(repo, inst.id, 'review'))!
    assert.equal(String(b.parentTaskId), String(a.id), '前置：后加签行的 parent＝刚办结那条')

    const res = await engine.recallTask(a.id, 'userA')
    assert.equal(res.taskState, TaskState.Doing)
    assert.equal((await repo.findTaskById(b.id))!.taskState, TaskState.Abandoned,
      '后加签行属下游 DOING ⇒ 真库里一并置 99')
    const [cnt] = await q(pool2, 'SELECT COUNT(*) AS n FROM wf_process_task WHERE task_name = ? AND task_state = 10 ' +
      'AND process_instance_id = ?', ['review', inst.id])
    assert.equal(Number(cnt.n), 1, '活待办只剩复活那一行')
  })

  it('⑦ 带病定义在发布腿即拒（真库 deploy 走同一条解析期校验）', async () => {
    const { facade } = makeStack()
    const badContent = chain({ allowAddSign: true, dynamicCountersign: true })
    const badName: string = JSON.parse(badContent).name
    const bad = await facade.flow('processDefine/deploy',
      { content: badContent, operator: 'rc' })
    assert.equal(bad.code, 99999999, JSON.stringify(bad))
    assert.match(String(bad.msg), /不允许同时配置 allowAddSign 与 dynamicCountersign/)
    // 计数只盯本条带病定义（rc246* 前缀被同文件各用例共用，LIKE 罩全部必然非 0）
    const [cnt] = await q(pool2, 'SELECT COUNT(*) AS n FROM wf_process_define WHERE name = ?', [badName])
    assert.equal(Number(cnt.n), 0, '带病定义没落库')
  })
})
