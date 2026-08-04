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
    assert.equal(row.create_user, 'user1') // issues/19: 用户列默认值优先 operator
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
    assert.equal(row.create_user, 'user1') // issues/19: 用户列默认值优先 operator
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

  it('⑩ BIGINT 用户列（issues/19）：create_user 为 BIGINT 存 userId', async () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`CREATE TABLE biz_settle (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      process_instance_id INTEGER,
      apply_user_id INTEGER,
      create_user INTEGER,
      update_user INTEGER,
      is_deleted INTEGER
    )`)
    const writer = new SqliteDynamicTableWriter(db)
    const repo = new MemoryRepository()
    const { engine } = setupEngine(repo, writer)
    let content = readFileSync(flowDir + '01-simple.json', 'utf-8')
    content = content.replace('"type": "approval"', '"type": "approval", "relTableName": "biz_settle"')
    const def: ProcessDefine = { id: 0, name: 'simple', displayName: '01-simple.json', type: 'approval', state: 1, content, version: 1, createTime: new Date(), updateTime: new Date(), createUser: '', updateUser: '' }
    repo.addDefine(def)

    const inst = await engine.startProcessInstanceById(def.id, '123', { f_title: '结算单', u_deptId: 'D01' })
    let doing = await repo.findDoingTasks(inst.id)
    await repo.addTaskActor(doing[0].id, ['123'])
    await engine.executeProcessTask(doing[0].id, '123', { [KeySubmitType]: 0 })
    doing = await repo.findDoingTasks(inst.id)
    await repo.addTaskActor(doing[0].id, ['leader'])
    await engine.executeProcessTask(doing[0].id, 'leader', { [KeySubmitType]: 1 })

    const row = db.prepare('SELECT create_user, apply_user_id FROM biz_settle').get() as any
    assert.equal(row.create_user, 123)
    assert.equal(row.apply_user_id, 123)
    db.close()
  })

  it('⑪ writer 用户列默认值：优先 apply_user_id，否则配置值回落', () => {
    const { db, writer } = setupDb()
    const data: Record<string, unknown> = { title: 't', apply_user_id: 'abc' }
    writer.fillSystemFields(data, true)
    assert.equal(data['create_user'], 'abc')
    writer.defaultUserValue = 0
    const data2: Record<string, unknown> = { title: 't' }
    writer.fillSystemFields(data2, true)
    assert.equal(data2['create_user'], 0)
    db.close()
  })

  it('⑫ 宽松列匹配（issues/20）：驼峰表单字段 ↔ 下划线表列', () => {
    const { db, writer } = setupDb()
    db.exec('ALTER TABLE biz_leave ADD COLUMN start_time TEXT')
    writer.insert('biz_leave', { startTime: '09:00:00', processInstanceId: 55, title: 'camel' })
    const row = db.prepare('SELECT start_time, process_instance_id FROM biz_leave').get() as any
    assert.equal(row.start_time, '09:00:00')
    assert.equal(row.process_instance_id, 55)
    const kept = writer.filterColumns('biz_leave', ['startTime', 'processInstanceId', 'no_such'])
    assert.equal(kept.length, 2)
    db.close()
  })

  it('⑬ 严格列匹配（issues/20）：显式开启后驼峰不再匹配', () => {
    const { db, writer } = setupDb()
    db.exec('ALTER TABLE biz_leave ADD COLUMN start_time TEXT')
    writer.strictColumnMatch = true
    writer.insert('biz_leave', { startTime: '09:00:00', title: 'strict' })
    const row = db.prepare('SELECT title, start_time FROM biz_leave').get() as any
    assert.equal(row.title, 'strict')
    assert.equal(row.start_time, null)
    db.close()
  })
})

// 追加：⑭ 非自增主键生成 / ⑮ 未配置生成器报错（issues/21）
describe('persist 主键生成（issues/21）', () => {
  it('⑭ 非自增主键（TEXT 雪花）配生成器后插入成功', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE biz_snow (id TEXT PRIMARY KEY, title TEXT)')
    const writer = new SqliteDynamicTableWriter(db)
    writer.primaryKeyGenerator = () => 'snow-888'
    writer.insert('biz_snow', { title: 'snow' })
    const row = db.prepare('SELECT id, title FROM biz_snow').get() as any
    assert.equal(row.id, 'snow-888')
    assert.equal(row.title, 'snow')
    // data 已含主键值 → 用之
    writer.insert('biz_snow', { id: 'manual-1', title: 'm' })
    const n = (db.prepare("SELECT COUNT(1) AS c FROM biz_snow WHERE id='manual-1'").get() as any).c
    assert.equal(n, 1)
    db.close()
  })

  it('⑮ 非自增主键未配生成器 → 清晰报错', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE biz_snow (id TEXT PRIMARY KEY, title TEXT)')
    const writer = new SqliteDynamicTableWriter(db) // 未配置生成器
    assert.throws(() => writer.insert('biz_snow', { title: 'x' }), /primary key generator/)
    db.close()
  })
})

describe('1.8.0 SYNC 同步演进', () => {
  function setupSync() {
    const db = new DatabaseSync(':memory:')
    db.exec(`CREATE TABLE biz_sync (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      amount REAL,
      opinion TEXT,
      apply INTEGER,
      task1 INTEGER,
      finish INTEGER,
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

  function loadSyncFlow(repo: MemoryRepository): ProcessDefine {
    let content = readFileSync(flowDir + '01-simple.json', 'utf-8')
    content = content.replace('"type": "approval"', '"type": "approval", "relTableName": "biz_sync", "persistMode": "SYNC"')
    content = content.replace('"assignee": "leader"', '"assignee": "leader", "field": {"PERMISSION_title": 1, "PERMISSION_amount": 2}')
    content = content.replaceAll('"id": "end"', '"id": "finish"')
    content = content.replaceAll('"targetNodeId": "end"', '"targetNodeId": "finish"')
    const def: ProcessDefine = { id: 0, name: 'simple', displayName: '01-simple.json', type: 'approval', state: 1, content, version: 1, createTime: new Date(), updateTime: new Date(), createUser: '', updateUser: '' }
    repo.addDefine(def)
    return def
  }

  it('⑥ SYNC 全链路：发起 INSERT → apply 推进 → task1（权限过滤 + tf_ + 状态）→ 结束定稿', async () => {
    const repo = new MemoryRepository()
    const { db, writer } = setupSync()
    const { engine } = setupEngine(repo, writer)
    const def = loadSyncFlow(repo)

    // ① 发起 → INSERT（title/amount）
    const inst = await engine.startProcessInstanceById(def.id, 'user1', { f_title: '年假申请', f_amount: 800, u_deptId: 'D01' })
    // ② apply 完成 → UPDATE（apply 状态=10）
    let doing = await repo.findDoingTasks(inst.id)
    await repo.addTaskActor(doing[0].id, ['user1'])
    await engine.executeProcessTask(doing[0].id, 'user1', { [KeySubmitType]: 0 })
    assert.equal((db.prepare('SELECT apply FROM biz_sync').get() as any).apply, 10)
    // ③ task1（leader）→ UPDATE：title 只读不更新 / amount 可编辑更新 / opinion(tf_) / task1=10 / finish=20
    doing = await repo.findDoingTasks(inst.id)
    await repo.addTaskActor(doing[0].id, ['leader'])
    await engine.executeProcessTask(doing[0].id, 'leader',
      { [KeySubmitType]: 1, tf_opinion: '同意', f_title: '修改标题', f_amount: 999 })
    const row = db.prepare('SELECT title, amount, opinion, task1, finish FROM biz_sync').get() as any
    assert.equal(row.title, '年假申请')          // 只读字段不更新
    assert.equal(row.amount, 999)                // 可编辑字段更新
    assert.equal(row.opinion, '同意')            // tf_ 冗余
    assert.equal(row.task1, 10)                  // 任务节点状态 DOING
    assert.equal(row.finish, 20)                 // 结束定稿 FINISHED
    const n = (db.prepare('SELECT COUNT(1) AS c FROM biz_sync').get() as any).c
    assert.equal(n, 1)                           // 先插后更仅 1 条
    db.close()
  })

  it('⑦ SYNC 驳回：结束定稿最终状态 REJECT=45，数据不丢', async () => {
    const repo = new MemoryRepository()
    const { db, writer } = setupSync()
    const { engine } = setupEngine(repo, writer)
    const def = loadSyncFlow(repo)

    const inst = await engine.startProcessInstanceById(def.id, 'user1', { f_title: '驳回单', u_deptId: 'D01' })
    let doing = await repo.findDoingTasks(inst.id)
    await repo.addTaskActor(doing[0].id, ['user1'])
    await engine.executeProcessTask(doing[0].id, 'user1', { [KeySubmitType]: 0 })
    doing = await repo.findDoingTasks(inst.id)
    await repo.addTaskActor(doing[0].id, ['leader'])
    await engine.executeProcessTask(doing[0].id, 'leader', { [KeySubmitType]: 2 })

    const row = db.prepare('SELECT title, finish, create_user FROM biz_sync').get() as any
    assert.equal(row.title, '驳回单')
    assert.equal(row.finish, 45)                 // 驳回最终状态 REJECT
    assert.equal(row.create_user, 'user1')
    db.close()
  })
})
