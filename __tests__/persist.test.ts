import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { EngineImpl } from '../src/engine.js'
import { MemoryRepository } from '../src/memory.js'
import { InstanceState, type ProcessDefine, type ProcessInstance } from '../src/model.js'
import type { ExpressionEvaluator, UserProvider } from '../src/spi.js'
import { KeySubmitType, KeyDeptID } from '../src/engine.js'
import { SqliteDynamicTableWriter, PersistPostInterceptor } from '../src/persist.js'
import type { EngineExtensions } from '../src/extensions.js'

const flowDir = '../jeeflow-java/jeeflow-core/src/test/resources/flows/'

function setupDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE biz_leave (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    amount REAL,
    process_instance_id INTEGER,
    apply_user_id TEXT,
    apply_dept_id TEXT,
    create_time TEXT,
    create_user TEXT,
    update_time TEXT,
    update_user TEXT,
    is_deleted INTEGER
  )`)
  const writer = new SqliteDynamicTableWriter(db)
  return { db, writer }
}

function loadFlow(repo: MemoryRepository, withRelTable = true): ProcessDefine {
  let content = readFileSync(flowDir + '01-simple.json', 'utf-8')
  if (withRelTable) {
    content = content.replace('"type": "approval"', '"type": "approval", "relTableName": "biz_leave"')
  }
  const def: ProcessDefine = { id: 0, name: 'simple', displayName: '01-simple.json', type: 'approval', state: 1, content, version: 1, createTime: new Date(), updateTime: new Date(), createUser: '', updateUser: '' }
  repo.addDefine(def)
  return def
}

function setupEngine(repo: MemoryRepository, writer: SqliteDynamicTableWriter | null) {
  const userProv: UserProvider = {
    async getUser(userId) { return { userId, realName: '用户' + userId, deptId: 'D01', deptName: '测试部门', postId: 'P01', postName: '测试岗位' } },
  }
  const idGen = { nextId() { return Date.now() * 1000 + Math.floor(Math.random() * 1000) } }
  const exprEval: ExpressionEvaluator = {
    async eval() { return false },
  }
  const engine = new EngineImpl(repo, userProv, idGen, exprEval)
  const ic = new PersistPostInterceptor(writer, async id => repo.findDefineById(id))
  const ext: EngineExtensions = { interceptors: [ic] }
  engine.setExtensions(ext)
  return { engine, ic }
}

async function runFlow(engine: EngineImpl, repo: MemoryRepository, defineId: number, agree = true): Promise<ProcessInstance> {
  const inst = await engine.startProcessInstanceById(defineId, 'user1', {
    f_title: '年假申请', f_amount: 800, u_deptId: 'D01',
  })
  let doing = await repo.findDoingTasks(inst.id)
  assert.equal(doing.length, 1)
  assert.equal(doing[0].taskName, 'apply')
  await repo.addTaskActor(doing[0].id, ['user1'])
  await engine.executeProcessTask(doing[0].id, 'user1', { [KeySubmitType]: 0 })

  doing = await repo.findDoingTasks(inst.id)
  assert.equal(doing.length, 1)
  assert.equal(doing[0].taskName, 'task1')
  await repo.addTaskActor(doing[0].id, ['leader'])
  await engine.executeProcessTask(doing[0].id, 'leader', { [KeySubmitType]: agree ? 1 : 2 })
  return inst
}

function countRows(db: DatabaseSync): number {
  const row = db.prepare('SELECT COUNT(1) AS c FROM biz_leave').get() as { c: number }
  return Number(row.c)
}

describe('persist 动态表写入 + 流程入库拦截器', () => {

  it('① 流程结束同意 → 业务表落库（f_ 去前缀 + 系统字段 + 流程上下文）', async () => {
    const { db, writer } = setupDb()
    const repo = new MemoryRepository()
    const { engine } = setupEngine(repo, writer)
    const def = loadFlow(repo, true)
    const inst = await runFlow(engine, repo, def.id, true)

    const row = db.prepare('SELECT title, amount, process_instance_id, apply_user_id, apply_dept_id, create_user, is_deleted FROM biz_leave').get() as any
    assert.equal(row.title, '年假申请')
    assert.equal(row.amount, 800)
    assert.equal(row.process_instance_id, inst.id)
    assert.equal(row.apply_user_id, 'user1')
    assert.equal(row.apply_dept_id, 'D01')
    assert.equal(row.create_user, 'system')
    assert.equal(row.is_deleted, 0)
    assert.equal(countRows(db), 1)
    db.close()
  })

  it('② 不同意/退回 → 不入库', async () => {
    const { db, writer } = setupDb()
    const repo = new MemoryRepository()
    const { engine } = setupEngine(repo, writer)
    const def = loadFlow(repo, true)
    await runFlow(engine, repo, def.id, false)
    assert.equal(countRows(db), 0)
    db.close()
  })

  it('③ 未注入 writer → 静默跳过', async () => {
    const { db } = setupDb()
    const repo = new MemoryRepository()
    const { engine } = setupEngine(repo, null)
    const def = loadFlow(repo, true)
    await runFlow(engine, repo, def.id, true)
    assert.equal(countRows(db), 0)
    db.close()
  })

  it('④ 未配置 relTableName → 缺省回落流程 name，表不存在 → 显性报错', async () => {
    const { db, writer } = setupDb()
    const repo = new MemoryRepository()
    const { engine } = setupEngine(repo, writer)
    const def = loadFlow(repo, false)
    await assert.rejects(runFlow(engine, repo, def.id, true), /not found/)
    db.close()
  })

  it('⑤ 幂等：同实例重复触发不重复插', async () => {
    const { db, writer } = setupDb()
    const repo = new MemoryRepository()
    const { engine, ic } = setupEngine(repo, writer)
    const def = loadFlow(repo, true)
    const inst = await runFlow(engine, repo, def.id, true)
    assert.equal(countRows(db), 1)
    // 模拟重复触发：拦截器直接再跑一次
    await ic.postHandle({ id: 'end', type: 'snaker:end', x: 0, y: 0, properties: {}, text: {} }, inst)
    assert.equal(countRows(db), 1)
    db.close()
  })

  it('⑥ writer 全字段插入 + 系统字段', () => {
    const { db, writer } = setupDb()
    const data: Record<string, unknown> = { title: '年假申请', amount: 800, process_instance_id: 1, apply_user_id: 'user1', apply_dept_id: 'D01' }
    writer.fillSystemFields(data, true)
    writer.insert('biz_leave', data)
    const row = db.prepare('SELECT title, process_instance_id, create_user, is_deleted FROM biz_leave').get() as any
    assert.equal(row.title, '年假申请')
    assert.equal(row.process_instance_id, 1)
    assert.equal(row.create_user, 'system')
    assert.equal(row.is_deleted, 0)
    db.close()
  })

  it('⑦ writer 缺列过滤', () => {
    const { db, writer } = setupDb()
    const kept = writer.filterColumns('biz_leave', ['title', 'no_such_col', 'amount'])
    assert.deepEqual(kept, ['title', 'amount'])
    db.close()
  })

  it('⑧ writer 防注入 + 表名安全', () => {
    const { db, writer } = setupDb()
    writer.insert('biz_leave', { title: "x'); DROP TABLE biz_leave; --" })
    assert.equal(countRows(db), 1)
    assert.throws(() => writer.insert('sys_user', { x: 1 }), /sys_/)
    assert.throws(() => writer.insert('biz_leave; DROP TABLE biz_leave', { x: 1 }), /illegal/)
    assert.throws(() => writer.filterColumns('sys_user', ['x']), /sys_/)
    db.close()
  })

  it('⑨ writer 幂等 exists', () => {
    const { db, writer } = setupDb()
    writer.insert('biz_leave', { title: 't', process_instance_id: 99 })
    assert.equal(writer.exists('biz_leave', 'process_instance_id', 99), true)
    assert.equal(writer.exists('biz_leave', 'process_instance_id', 100), false)
    db.close()
  })
})
