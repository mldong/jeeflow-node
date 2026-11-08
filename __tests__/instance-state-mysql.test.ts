/**
 * issues/250 —— 任务列表行带所属流程实例的状态（instanceState）· 真库（160 MySQL）腿。
 *
 * 为什么要单独一条真库腿：内存仓也设了该字段，门面级用例照不出 SQL 漏投这一列
 * （issues/249 同形教训：Java 侧摘掉 SQL 投影读之后内存仓 66 格全绿、只有真库腿报红）。
 * 这里绕过门面直接读仓储行（pageTodoTasks/pageDoneTasks → 真 SQL → mapTaskRow），
 * 同时钉门面 JSON 出口的 camelCase 键 instanceState。内部对照＝同一实例办结前后读数
 * 必须不同（10 → 20）：进行中读待办行必须是 10、办结后读已办行 taskState 仍是 20 但
 * instanceState=20 —— 两格合起来挡住「恒 10 / 恒 20 / 恒 undefined」这类假绿。
 *
 * 用法：node --import tsx --test __tests__/instance-state-mysql.test.ts（连 160，与 tx-tier 同纪律）
 * 固定 define id 960004（本文件专用；与 jdbc.test.ts 的 900004/910004、tx-tier 的 920004、
 * recall-collect 的 950004 不冲突）。
 * id 生成用槽位 5（jdbc.test.ts 用槽位 2、tx-tier 用 0、recall-collect 用 4，
 * 见 jdbc.test.ts STACK_SEQ 注释）⇒ 并发跑同库不撞主键。
 */
import { after, before, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import mysql from 'mysql2/promise'
import { EngineImpl, KeySubmitType } from '../src/engine.js'
import { JdbcRepository, MysqlAdapter } from '../src/jdbc/index.js'
import { JeeflowFacade } from '../src/facade.js'
import { InstanceState, SubmitType, TaskState } from '../src/model.js'
import type { IDGenerator, UserProvider } from '../src/spi.js'

const DB_HOST = process.env.JEFFLOW_DB_HOST ?? '192.168.1.160'
const DB_PORT = Number(process.env.JEFFLOW_DB_PORT ?? 3306)
const DB_USER = process.env.JEFFLOW_DB_USER ?? 'root'
const DB_PWD = process.env.JEFFLOW_DB_PWD ?? '8Eli#gr#AUk'
const DEFINE_ID = '960004'
const SCHEMA_DIR = 'tests/schema/'

const pool: any = mysql.createPool({
  host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PWD,
  database: 'jeeflow', charset: 'utf8mb4', connectionLimit: 5,
  supportBigNumbers: true, bigNumberStrings: true,
})

const userProv: UserProvider = {
  async getUser(userId) {
    return { userId, realName: userId, deptId: 'D01', deptName: '部门', postId: 'P01', postName: '岗位' }
  },
}

/** 槽位 5（jdbc.test.ts 用槽位 2；式样见该文件 STACK_SEQ 注释） */
class SeqIDGen implements IDGenerator {
  private base = Date.now() * 4000 + 5 * 1000
  private n = 0
  nextId(): string { this.n += 1; return String(this.base + this.n) }
}

// ─── 夹具（内联 JSON，与 recall-collect 真库腿同形状，不碰共享 flows/ 目录） ───

const nodeOf = (id: string, type: string, props: Record<string, any>, text: string) =>
  ({ id, type, x: 0, y: 0, properties: props, text: { value: text } })
const edgeOf = (id: string, from: string, to: string) =>
  ({ id, type: 'snaker:transition', sourceNodeId: from, targetNodeId: to, properties: {} })

/** start → apply(applicant) → review(leader，末任务节点) → end：办结 review 即实例完成 */
function chain(): string {
  return JSON.stringify({
    name: 'is250', displayName: 'issues/250 instanceState 真库夹具', type: 'approval',
    nodes: [
      nodeOf('start', 'snaker:start', {}, '开始'),
      nodeOf('apply', 'snaker:task', { form: 'apply-form', assignee: 'applicant', taskType: 0, performType: 0 }, '发起申请'),
      nodeOf('review', 'snaker:task', { form: 'form-r', assignee: 'leader', taskType: 0, performType: 0 }, '终审'),
      nodeOf('end', 'snaker:end', {}, '结束'),
    ],
    edges: [edgeOf('e1', 'start', 'apply'), edgeOf('e2', 'apply', 'review'), edgeOf('e3', 'review', 'end')],
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
      [DEFINE_ID, raw.name, raw.displayName, raw.type, jsonStr, now, 'is250', now, 'is250'])
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
  const repo = new JdbcRepository(new MysqlAdapter(pool), new SeqIDGen())
  const engine = new EngineImpl(repo, userProv as any, new SeqIDGen(), { async eval() { return false } } as any)
  return { repo, engine, facade: new JeeflowFacade(engine, repo) }
}

before(async () => {
  await applySchema()
  await cleanup()
})

after(async () => {
  await cleanup()
  await pool.end()
})

describe('issues/250 真库腿（160 MySQL）：任务行投影 instance_state', () => {
  it('进行中待办行 instanceState=10；办结末节点后已办行 taskState=20 / instanceState=20（仓储＋门面双出口）', async () => {
    const { engine, repo, facade } = makeStack()
    await putDefine(chain())
    const inst = await engine.startProcessInstanceById(DEFINE_ID, 'zhangsan', {})
    // 引擎不自动执行任何节点：调用方完成申请节点（submitType=0）
    for (const t of await repo.findDoingTasks(inst.id)) {
      await engine.executeProcessTask(t.id, 'zhangsan', { [KeySubmitType]: SubmitType.Apply })
    }
    assert.equal((await repo.findInstanceById(inst.id))!.state, InstanceState.Doing, '前置：实例进行中')
    const review = (await repo.findDoingTasks(inst.id)).find(t => t.taskName === 'review')
    assert.ok(review, '前置：终审（末任务节点）应在办')

    // 共享库可能有兄弟栈的 leader 行：条件 scoped 到本实例（白名单列 t.process_instance_id）
    const scope = [{ column: 't.process_instance_id', operator: 'EQ', value: inst.id }]

    // ① 真 SQL 腿（绕过门面）：待办行 instanceState=10 —— SQL 漏投 instance_state 这一列在这里读 0，必红
    const todo = (await repo.pageTodoTasks(1, 50, 'leader', scope)).rows
    assert.equal(todo.length, 1, '正向对照：leader 在本实例恰有一条待办')
    assert.equal(todo[0].taskState, TaskState.Doing)
    assert.equal(todo[0].instanceState, 10, '实例进行中 ⇒ 待办行 instanceState=10')
    // 门面 JSON 出口：camelCase 键 instanceState 必须投出（todoList）
    const rTodo = await facade.flow('processTask/todoList',
      { operator: 'leader', pageSize: 100, m_EQ_processInstanceId: inst.id })
    assert.equal(rTodo.code, 0, JSON.stringify(rTodo))
    const todoRow = rTodo.data.rows.find((r: any) => String(r.processInstanceId) === String(inst.id))
    assert.ok(todoRow, '门面 todoList 应有本实例行')
    assert.ok('instanceState' in todoRow, 'JSON 出口必须带 instanceState 键（camelCase）')
    assert.equal(todoRow.instanceState, 10)

    // 办结末节点 ⇒ 实例完成（20）
    await engine.executeProcessTask(review!.id, 'leader', { [KeySubmitType]: SubmitType.Agree })
    assert.equal((await repo.findInstanceById(inst.id))!.state, InstanceState.Done, '前置：实例已完成')

    // ② 承重格：已办行自身 taskState 仍是 20，只有 instanceState 能告诉前端这单已走完
    const done = (await repo.pageDoneTasks(1, 50, 'leader', scope)).rows
    assert.equal(done.length, 1, '正向对照：leader 在本实例恰有一条已办（申请节点是 zhangsan 办的）')
    assert.equal(done[0].taskState, TaskState.Done, '前置：任务行自身仍是已完成（20）')
    assert.equal(done[0].instanceState, 20, '实例已结束 ⇒ SQL 必须把 pi.state 投出来（任务态照不出这一格）')
    const rDone = await facade.flow('processTask/doneList',
      { operator: 'leader', pageSize: 100, m_EQ_processInstanceId: inst.id })
    assert.equal(rDone.code, 0, JSON.stringify(rDone))
    const doneRow = rDone.data.rows.find((r: any) => String(r.id) === String(review!.id))
    assert.ok(doneRow, '门面 doneList 应有终审行')
    assert.ok('instanceState' in doneRow, 'JSON 出口必须带 instanceState 键（camelCase）')
    assert.equal(doneRow.taskState, 20)
    assert.equal(doneRow.instanceState, 20, '实例已结束 ⇒ 已办行 instanceState 必须是 20，否则前端无从置灰')
  })
})