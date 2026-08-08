import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { EngineImpl } from '../src/engine.js'
import { MemoryRepository } from '../src/memory.js'
import { InstanceState, type ProcessDefine, type ProcessInstance } from '../src/model.js'
import type { ExpressionEvaluator, UserProvider } from '../src/spi.js'
import { KeySubmitType, KeyDeptID } from '../src/engine.js'
import { SqliteDynamicTableWriter, PersistPostInterceptor, registerPersistMeta } from '../src/persist.js'
import { HandlerRegistry } from '../src/registry.js'
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
  const idGen = { nextId() { return String(Date.now() * 1000 + Math.floor(Math.random() * 1000)) } }
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
    // sqlite 驱动返回 INTEGER 为 number，归一化后与引擎 string id 比较（issue 38 E9）
    assert.equal(String(row.process_instance_id), inst.id)
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
    content = content.replace('"assignee": "leader"', '"assignee": "leader", "field": {"PERMISSION_f_title": 1, "PERMISSION_amount": 2}')
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

describe('1.8.2 issues/26 字段权限绕过', () => {
  it('⑧ 办理提交被拒字段不入变量——下游无权限节点不可绕过上游只读', async () => {
    const repo = new MemoryRepository()
    const db = new DatabaseSync(':memory:')
    db.exec(`CREATE TABLE biz_perm3 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT, amount REAL,
      apply INTEGER, approve1 INTEGER, approve2 INTEGER, finish INTEGER,
      process_instance_id INTEGER,
      create_user TEXT, is_deleted INTEGER
    )`)
    const writer = new SqliteDynamicTableWriter(db)
    const { engine } = setupEngine(repo, writer)
    const content = JSON.stringify({
      name: 'perm3', displayName: '权限绕过验证', type: 'approval',
      relTableName: 'biz_perm3', persistMode: 'SYNC',
      nodes: [
        { id: 'start', type: 'snaker:start', properties: {}, text: { value: '开始' } },
        { id: 'apply', type: 'snaker:task', properties: { assignee: 'applicant', taskType: 0, performType: 0 }, text: { value: '发起申请' } },
        { id: 'approve1', type: 'snaker:task', properties: { assignee: 'leader1', taskType: 0, performType: 0, field: { PERMISSION_f_title: 1, PERMISSION_amount: 2 } }, text: { value: '审批一' } },
        { id: 'approve2', type: 'snaker:task', properties: { assignee: 'leader2', taskType: 0, performType: 0 }, text: { value: '审批二' } },
        { id: 'finish', type: 'snaker:end', properties: {}, text: { value: '结束' } },
      ],
      edges: [
        { id: 'e0', sourceNodeId: 'start', targetNodeId: 'apply', properties: {} },
        { id: 'e1', sourceNodeId: 'apply', targetNodeId: 'approve1', properties: {} },
        { id: 'e2', sourceNodeId: 'approve1', targetNodeId: 'approve2', properties: {} },
        { id: 'e3', sourceNodeId: 'approve2', targetNodeId: 'finish', properties: {} },
      ],
    })
    const def: ProcessDefine = { id: 0, name: 'perm3', displayName: 'perm3', type: 'approval', state: 1, content, version: 1, createTime: new Date(), updateTime: new Date(), createUser: '', updateUser: '' }
    repo.addDefine(def)

    const inst = await engine.startProcessInstanceById(def.id, 'user1', { f_title: '原始标题', f_amount: 800, u_deptId: 'D01' })
    const completeNamed = async (name: string, actor: string, args: Record<string, any>) => {
      const doing = await repo.findDoingTasks(inst.id)
      const d = doing.find(x => x.taskName === name)
      assert.ok(d, `task ${name} not found`)
      await repo.addTaskActor(d.id, [actor])
      await engine.executeProcessTask(d.id, actor, args)
    }
    await completeNamed('apply', 'user1', { [KeySubmitType]: 0 })
    // approve1 只读 title，提交 TRY_HACK → 引擎入口过滤 → 不入变量 → 不落库
    await completeNamed('approve1', 'leader1', { [KeySubmitType]: 1, f_title: 'TRY_HACK' })
    // approve2 无权限声明——变量无 TRY_HACK，title 保持原值
    await completeNamed('approve2', 'leader2', { [KeySubmitType]: 1, f_amount: 999 })

    const row = db.prepare('SELECT title, amount, approve1, approve2, finish FROM biz_perm3').get() as any
    assert.equal(row.title, '原始标题')          // 只读被拒值不应落库（下游不可绕过）
    assert.equal(row.amount, 999)
    assert.equal(row.approve1, 10)
    assert.equal(row.approve2, 10)
    assert.equal(row.finish, 20)
    db.close()
  })
})

describe('1.8.4 issues/34 定义级拦截器 + 30/31 facade', () => {
  it('⑨ 定义级拦截器：postInterceptors 声明按名解析，未声明流程不触发', async () => {
    const repo = new MemoryRepository()
    const db = new DatabaseSync(':memory:')
    db.exec(`CREATE TABLE biz_decl (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT,
      process_instance_id INTEGER, is_deleted INTEGER
    )`)
    const writer = new SqliteDynamicTableWriter(db)
    const ic = new PersistPostInterceptor(writer, async id => repo.findDefineById(id))
    const userProv: UserProvider = { async getUser(userId) { return { userId, realName: '用户' + userId, deptId: 'D01' } } }
    const engine = new EngineImpl(repo, userProv, { nextId() { return String(Date.now()) } }, { async eval() { return false } })
    // 注册表挂载（定义级）
    engine.setExtensions({ interceptors: [], interceptorRegistry: { persist: ic } })

    const loadFlow = (name: string, table: string, declared: string): ProcessDefine => ({
      id: 0, name, displayName: name, type: 'approval', state: 1, version: 1,
      content: JSON.stringify({
        name, displayName: name, type: 'approval', relTableName: table, persistMode: 'SYNC',
        postInterceptors: declared,
        nodes: [
          { id: 'start', type: 'snaker:start', properties: {}, text: { value: '开始' } },
          { id: 'finish', type: 'snaker:end', properties: {}, text: { value: '结束' } },
        ],
        edges: [{ id: 'e0', sourceNodeId: 'start', targetNodeId: 'finish', properties: {} }],
      }),
      createTime: new Date(), updateTime: new Date(), createUser: '', updateUser: '',
    })
    const d1 = loadFlow('decl1', 'biz_decl', 'persist')
    repo.addDefine(d1)
    await engine.startProcessInstanceById(d1.id, 'user1', { f_title: '声明流程' })
    const n1 = (db.prepare('SELECT COUNT(1) AS c FROM biz_decl').get() as any).c
    assert.equal(n1, 1)
    const d2 = loadFlow('decl2', 'biz_decl', '')
    repo.addDefine(d2)
    await engine.startProcessInstanceById(d2.id, 'user2', { f_title: '未声明流程' })
    const n2 = (db.prepare('SELECT COUNT(1) AS c FROM biz_decl').get() as any).c
    assert.equal(n2, 1, '未声明拦截器的流程不应落库')
    db.close()
  })

  it('⑨.1 issues/60 定义级声明未注册 → 显式报错（不静默跳过）', async () => {
    const repo = new MemoryRepository()
    const engine = new EngineImpl(repo, { async getUser(userId) { return { userId, realName: '用户' + userId, deptId: 'D01' } } },
      { nextId() { return String(Date.now()) } }, { async eval() { return false } })
    engine.setExtensions({ interceptors: [], interceptorRegistry: {} })
    const ghost = {
      id: 0, name: 'ghost', displayName: '幽灵拦截器', type: 'approval', state: 1, version: 1,
      content: JSON.stringify({
        name: 'ghost', displayName: '幽灵拦截器', type: 'approval', relTableName: 'biz_ghost', persistMode: 'SYNC',
        postInterceptors: 'com.xxx.GhostInterceptor',
        nodes: [
          { id: 'start', type: 'snaker:start', properties: {}, text: { value: '开始' } },
          { id: 'finish', type: 'snaker:end', properties: {}, text: { value: '结束' } },
        ],
        edges: [{ id: 'e0', sourceNodeId: 'start', targetNodeId: 'finish', properties: {} }],
      }),
      createTime: new Date(), updateTime: new Date(), createUser: '', updateUser: '',
    }
    repo.addDefine(ghost)
    await assert.rejects(
      () => engine.startProcessInstanceById(ghost.id, 'user1', { f_title: '幽灵流程' }),
      /未注册/,
    )
  })

  it('⑨.2 issues/60 注册助手 registerPersistMeta（字典 1 项 / 全名 / 显示名 / post 组 / 同名覆盖）', () => {
    const reg = new HandlerRegistry()
    registerPersistMeta(reg)
    const metas = reg.listHandlers('FlowInterceptor')
    assert.equal(metas.length, 1)
    assert.equal(metas[0].name, 'com.mldong.jeeflow.persist.interceptor.PersistPostInterceptor')
    assert.equal(metas[0].displayName, '业务数据自动入库')
    assert.equal(metas[0].group, 'post')
    assert.equal(metas[0].order, 0)
    // 二次注册同名覆盖（Node 注册表 Map 语义，与 Java/Go/Python 追加语义对齐输出：字典同名唯一）
    registerPersistMeta(reg)
    assert.equal(reg.listHandlers('FlowInterceptor').length, 1)
  })

  it('⑩ facade 顶层 JSON 保存 + listByType + bizData', async () => {
    const { JeeflowFacade } = await import('../src/index.js')
    const repo = new MemoryRepository()
    // 内存扩展仓储（mock，避免测试依赖真实数据库 adapter）——id 为 string（issue 38 E9）
    const designs = new Map<string, any>()
    const hisMap = new Map<string, any[]>()
    let dseq = 1
    const ext: any = {
      async findDesignById(id) { return designs.get(id) ?? null },
      async saveDesign(d) { if (!d.id) d.id = String(dseq++); designs.set(d.id, d) },
      async updateDesign(d) { designs.set(d.id, d) },
      async removeDesign(id) { designs.delete(id); hisMap.delete(id) },
      async pageDesigns() { return [[...designs.values()], designs.size] },
      async saveDesignHis(h) { hisMap.set(h.processDesignId, [h, ...(hisMap.get(h.processDesignId) ?? [])]) },
      async listDesignHis(id) { return hisMap.get(id) ?? [] },
      async findSurrogateById() { return null }, async saveSurrogate() {}, async updateSurrogate() {},
      async removeSurrogate() {}, async pageSurrogates() { return [[], 0] }, async getSurrogate() { return null },
    }
    const userProv: UserProvider = { async getUser(userId) { return { userId, realName: '用户' + userId, deptId: 'D01' } } }
    const engine = new EngineImpl(repo, userProv, { nextId() { return String(Date.now()) } }, { async eval() { return false } })
    const facade = new JeeflowFacade(engine, repo, ext)
    ext.saveDesign({ id: '1', name: 'old', displayName: '旧名', type: 'approval', icon: '', isDeployed: 0, remark: '', createTime: new Date(), createUser: '', updateTime: new Date(), updateUser: '' })

    // 顶层 JSON 保存（无 content）——issue 31
    const r = await facade.flow('processDesign/updateDefine', {
      processDesignId: 1, operator: 'user1',
      name: 'topjson', displayName: '顶层JSON', type: 'approval',
      relTableName: 'biz_top', nodes: [], edges: [],
    })
    assert.equal(r.code, 0, JSON.stringify(r))
    const his = await ext.listDesignHis('1')
    assert.ok(his.length > 0 && his[0].content.includes('"nodes"'))

    // listByType——issue 30
    const lt = await facade.flow('processDesign/listByType', {})
    assert.equal(lt.code, 0, JSON.stringify(lt))
    assert.ok(lt.data.approval?.some((x: any) => x.name === 'topjson'))

    // bizData 未注册 → 报错；注册后回显
    const saveFlow = await facade.flow('processDesign/updateDefine', {
      processDesignId: 1, operator: 'user1',
      content: readFileSync(flowDir + '01-simple.json', 'utf-8').replace('"type": "approval"', '"type": "approval", "relTableName": "biz_top"'),
    })
    assert.equal(saveFlow.code, 0, JSON.stringify(saveFlow))
    const dep = await facade.flow('processDesign/deploy', { id: 1, operator: 'user1' })
    assert.equal(dep.code, 0, JSON.stringify(dep))
    const sr = await facade.flow('processInstance/startAndExecute', { processDefineId: dep.data.processDefineId, operator: 'user1', f_title: 'x' })
    assert.equal(sr.code, 0, JSON.stringify(sr))
    const bd = await facade.flow('processInstance/bizData', { processInstanceId: sr.data.processInstanceId })
    assert.ok(bd.code !== 0 && String(bd.msg).includes('setMetaReader'))
    facade.setMetaReader({ readByProcessInstance(t: string, pid: unknown) { return { tableName: t, title: '业务数据' } } })
    const bd2 = await facade.flow('processInstance/bizData', { processInstanceId: sr.data.processInstanceId })
    assert.equal(bd2.code, 0, JSON.stringify(bd2))
    assert.equal(bd2.data.tableName, 'biz_top')
  })
})
