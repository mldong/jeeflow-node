// 事务档判据（audit8 R9 / 145-2，spec/12 §12.2 覆盖面＋原子面＋归属面）——真库（160 MySQL）。
//
// 六档：① 空转档（提交前独立连接读不到＝写真在事务连接上）② 引擎入口原子档（入口内中途注入
// 异常 ⇒ 整体回滚）③ 门面复合动作档（startAndExecute 三拍一笔原子）＋裸拼红样（不经门面留半完成，
// 钉住门面包裹修的是什么）④ 嵌套 join 归属档（withTx/引擎 inTx 嵌套并入外层，外层回滚连坐）
// ⑤ ext 腿逐表反查（145-2②：设计/历史/委托三表随主仓事务回滚）⑥ transactionAwarePool writer 腿
// （C99 ⑥ node 腿：集成侧写腿经事务感知池并入动作事务；裸池对照=逃逸留存）＋监听器 e2e 腿。
//
// 用法：node --import tsx --test __tests__/tx-tier-145.test.ts
// 固定 define id 920004（本文件专用；与 jdbc.test.ts 的 900004/910004 不冲突）。
// 本文件 id 生成用 SeqIDGen 槽位 0（jdbc.test.ts 用槽位 2，见该文件 STACK_SEQ 注释；
// 两文件若并发跑同库，槽位不同不撞主键）。
import { after, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import mysql from 'mysql2/promise'
import { EngineImpl } from '../src/engine.js'
import { JdbcRepository, transactionAwarePool } from '../src/jdbc/index.js'
import { MysqlAdapter } from '../src/jdbc/mysql.js'
import { JdbcProcessExtRepository } from '../src/jdbc/ext.js'
import { JeeflowFacade } from '../src/facade.js'
import { InstanceState, ProcessInstance, type ProcessDesign, type ProcessDesignHis, type ProcessSurrogate, type ProcessDefine } from '../src/model.js'
import { EventType } from '../src/extensions.js'
import { dir as flowsResolverDir } from '../flows-resolver.js'
import type { IDGenerator, UserProvider } from '../src/spi.js'

const DB_HOST = process.env.JEFFLOW_DB_HOST ?? '192.168.1.160'
const DB_PORT = Number(process.env.JEFFLOW_DB_PORT ?? 3306)
const DB_USER = process.env.JEFFLOW_DB_USER ?? 'root'
const DB_PWD = process.env.JEFFLOW_DB_PWD ?? '8Eli#gr#AUk'
const DEFINE_ID = 920004
const FLOW_DIR = flowsResolverDir() + '/'
const SCHEMA_DIR = 'tests/schema/'

const pool: any = mysql.createPool({ host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PWD, database: 'jeeflow', charset: 'utf8mb4', connectionLimit: 5 })
// 独立取证池（空转档与"逃逸对照"必须走与事务无关的第二条连接）
const pool2: any = mysql.createPool({ host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PWD, database: 'jeeflow', charset: 'utf8mb4', connectionLimit: 2 })

after(async () => {
  await pool.end()
  await pool2.end()
})

const userProv: UserProvider = {
  async getUser(userId) {
    return { userId, realName: userId, deptId: 'D01', deptName: '部门', postId: 'P01', postName: '岗位' }
  },
}

/** 槽位 0（jdbc.test.ts 用槽位 2；式样见该文件 STACK_SEQ 注释） */
class SeqIDGen implements IDGenerator {
  private base = Date.now() * 4000 + 0 * 1000
  private n = 0
  nextId(): string { this.n += 1; return String(this.base + this.n) }
}

/** 直查（独立池）：统一 `?` 占位符 */
async function qPool(p: any, sql: string, args: any[] = []): Promise<any[]> {
  const [rows] = await p.execute(sql, args)
  return rows as any[]
}

function makeAdapter(p: any) {
  return new MysqlAdapter(p)
}

/** 在 `saveTask` / `addTaskActor` 处注入中途失败（模拟动作执行到一半撞错） */
class FlakyRepo extends JdbcRepository {
  failOnSaveTask = false
  failOnAddTaskActor = false
  override async saveTask(task: any): Promise<void> {
    if (this.failOnSaveTask) throw new Error('injected: saveTask failed mid-action')
    return super.saveTask(task)
  }
  override async addTaskActor(taskId: string, actors: string[]): Promise<void> {
    if (this.failOnAddTaskActor) throw new Error('injected: addTaskActor failed mid-action')
    return super.addTaskActor(taskId, actors)
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
    // writer 腿业务探针表（本文件自建，不进 schema 分发面）
    await conn.execute('CREATE TABLE IF NOT EXISTS biz_tx_probe (id BIGINT PRIMARY KEY, tag VARCHAR(64))')
  } finally {
    conn.release()
  }
}

async function cleanup(): Promise<void> {
  const conn = await pool.getConnection()
  try {
    await conn.execute('DELETE FROM wf_process_task_actor WHERE process_task_id IN (SELECT id FROM wf_process_task WHERE process_instance_id IN (SELECT id FROM wf_process_instance WHERE process_define_id = ?))', [DEFINE_ID])
    await conn.execute('DELETE FROM wf_process_cc_instance WHERE process_instance_id IN (SELECT id FROM wf_process_instance WHERE process_define_id = ?)', [DEFINE_ID])
    await conn.execute('DELETE FROM wf_process_task WHERE process_instance_id IN (SELECT id FROM wf_process_instance WHERE process_define_id = ?)', [DEFINE_ID])
    await conn.execute('DELETE FROM wf_process_instance WHERE process_define_id = ?', [DEFINE_ID])
    await conn.execute('DELETE FROM wf_process_define WHERE id = ?', [DEFINE_ID])
    await conn.execute("DELETE FROM wf_process_design_his WHERE process_design_id IN (SELECT id FROM wf_process_design WHERE name LIKE 'txtier-%')")
    await conn.execute("DELETE FROM wf_process_design WHERE name LIKE 'txtier-%'")
    await conn.execute("DELETE FROM wf_process_surrogate WHERE operator LIKE 'txtier-%'")
    await conn.execute("DELETE FROM biz_tx_probe WHERE tag LIKE 'txtier-%'")
  } finally {
    conn.release()
  }
}

async function insertDefine(): Promise<void> {
  const content = readFileSync(FLOW_DIR + '01-simple.json', 'utf-8')
  const raw = JSON.parse(content)
  const now = new Date()
  const conn = await pool.getConnection()
  try {
    await conn.execute(
      'INSERT INTO wf_process_define (id, name, display_name, type, state, content, version, create_time, create_user, update_time, update_user) VALUES (?,?,?,?,1,?,1,?,?,?,?)',
      [DEFINE_ID, 'txtier-simple', raw.displayName, raw.type, content, now, 'txtier', now, 'txtier'])
  } finally {
    conn.release()
  }
}

async function countInstances(): Promise<number> {
  const rows = await qPool(pool2, 'SELECT COUNT(*) AS n FROM wf_process_instance WHERE process_define_id = ?', [DEFINE_ID])
  return Number(rows[0].n)
}
async function countTasks(): Promise<number> {
  const rows = await qPool(pool2, 'SELECT COUNT(*) AS n FROM wf_process_task WHERE process_instance_id IN (SELECT id FROM wf_process_instance WHERE process_define_id = ?)', [DEFINE_ID])
  return Number(rows[0].n)
}
async function countActors(): Promise<number> {
  const rows = await qPool(pool2, 'SELECT COUNT(*) AS n FROM wf_process_task_actor WHERE process_task_id IN (SELECT id FROM wf_process_task WHERE process_instance_id IN (SELECT id FROM wf_process_instance WHERE process_define_id = ?))', [DEFINE_ID])
  return Number(rows[0].n)
}

function newInstance(idg: IDGenerator): ProcessInstance {
  const now = new Date()
  return new ProcessInstance({
    id: idg.nextId(), defineId: DEFINE_ID, state: InstanceState.Doing, operator: 'zhangsan',
    businessNo: 'TXT-001', variables: { k: 'v' }, createTime: now, updateTime: now,
    createUser: 'zhangsan', updateUser: 'zhangsan',
  })
}

describe(`事务档 145-2（mysql @ ${DB_HOST}）`, () => {
  it('① 空转档：事务提交前独立连接读不到、提交后才可见（写真在事务连接上）', async () => {
    try {
      await applySchema()
      await cleanup()
      const repo = new JdbcRepository(makeAdapter(pool), new SeqIDGen())
      const inst = newInstance(new SeqIDGen())
      await repo.withTx(async () => {
        await repo.saveInstance(inst)
        const outside = await qPool(pool2, 'SELECT COUNT(*) AS n FROM wf_process_instance WHERE id = ?', [inst.id])
        assert.equal(Number(outside[0].n), 0, '提交前独立连接必须读不到（读到 ⇒ 仓储绕过了事务连接＝空转）')
        // 事务内绑定读照旧可用
        assert.ok(await repo.findInstanceById(inst.id), '事务内可读（连接绑定生效）')
      })
      const after = await qPool(pool2, 'SELECT COUNT(*) AS n FROM wf_process_instance WHERE id = ?', [inst.id])
      assert.equal(Number(after[0].n), 1, '提交后独立连接可见')
    } finally {
      await cleanup()
    }
  })

  it('② 原子档（引擎入口）：入口内中途注入异常 ⇒ 实例/任务全回滚；同路径不注入本来会成功', async () => {
    try {
      await applySchema()
      await cleanup()
      await insertDefine()
      const repo = new FlakyRepo(makeAdapter(pool), new SeqIDGen())
      const engine = new EngineImpl(repo, userProv, new SeqIDGen())

      // 阳性对照：不注入 ⇒ 同一路径成功落库（防"注入把流程挡在更早处"的假阳性）
      const okInst = await engine.startProcessInstanceById(DEFINE_ID, 'zhangsan', {})
      assert.equal(await countInstances(), 1, '不注入时正常落库')
      assert.ok(okInst.id, '实例返回')
      await cleanup()
      await insertDefine()

      // 注入：saveInstance 之后 saveTask 抛 ⇒ 入口包裹必须把整笔回滚掉
      repo.failOnSaveTask = true
      await assert.rejects(() => engine.startProcessInstanceById(DEFINE_ID, 'zhangsan', {}), /injected/)
      repo.failOnSaveTask = false
      assert.equal(await countInstances(), 0, '入口级事务必须整体回滚（不包时会留下半完成实例行）')
      assert.equal(await countTasks(), 0, '任务行 0')
    } finally {
      await cleanup()
    }
  })

  it('③ 动作档：门面 startAndExecute 中途失败 ⇒ 三表全回滚（复合动作一笔原子）', async () => {
    try {
      await applySchema()
      await cleanup()
      await insertDefine()
      const repo = new FlakyRepo(makeAdapter(pool), new SeqIDGen())
      const engine = new EngineImpl(repo, userProv, new SeqIDGen())
      const facade = new JeeflowFacade(engine, repo, undefined)

      repo.failOnAddTaskActor = true
      const res = await facade.flow('processInstance/startAndExecute', { processDefineId: DEFINE_ID, operator: 'zhangsan' })
      repo.failOnAddTaskActor = false

      assert.equal(res.code, 99999999, '复合动作必须以失败信封收场')
      assert.equal(await countInstances(), 0, '实例行必须整体回滚')
      assert.equal(await countTasks(), 0, '任务行必须整体回滚（逐拍提交会留行）')
      assert.equal(await countActors(), 0, '参与者行必须整体回滚')
    } finally {
      await cleanup()
    }
  })

  it('③r 动作档红样（裸拼对照）：不经门面手工编排 ⇒ 中途失败留半完成（钉住门面包裹修的是什么）', async () => {
    try {
      await applySchema()
      await cleanup()
      await insertDefine()
      const repo = new FlakyRepo(makeAdapter(pool), new SeqIDGen())
      const engine = new EngineImpl(repo, userProv, new SeqIDGen())

      const inst = await engine.startProcessInstanceById(DEFINE_ID, 'zhangsan', {}) // 入口自成一笔，已提交
      const doing = await repo.findDoingTasks(inst.id)
      repo.failOnAddTaskActor = true
      await assert.rejects(() => repo.addTaskActor(doing[0].id, ['zhangsan']), /injected/)
      repo.failOnAddTaskActor = false

      assert.equal(await countInstances(), 1, '裸拼红样：实例行留存＝半完成（门面动作档包裹对症的就是这里）')
    } finally {
      await cleanup()
    }
  })

  it('④ 归属档：withTx/引擎 inTx 嵌套并入外层——外层回滚连坐内层写（不再双开事务）', async () => {
    try {
      await applySchema()
      await cleanup()
      const repo = new JdbcRepository(makeAdapter(pool), new SeqIDGen())
      const engine = new EngineImpl(repo, userProv, new SeqIDGen())
      const inst = newInstance(new SeqIDGen())
      const defId = new SeqIDGen().nextId()
      const def: ProcessDefine = {
        id: defId, name: 'txtier-nested', displayName: '嵌套', type: 'approval', state: 1,
        content: '{}', version: 1, createTime: new Date(), createUser: 't', updateTime: new Date(), updateUser: 't',
      }

      await assert.rejects(() => repo.withTx(async () => {
        await repo.withTx(async () => { await repo.saveInstance(inst) }) // 嵌套 withTx：join 支，不得自行提交
        await engine.inTx(async () => { await repo.saveDefine(def) })    // 经引擎包裹：并入同一段
        throw new Error('outer boom')
      }), /outer boom/)

      const instRows = await qPool(pool2, 'SELECT COUNT(*) AS n FROM wf_process_instance WHERE id = ?', [inst.id])
      const defRows = await qPool(pool2, 'SELECT COUNT(*) AS n FROM wf_process_define WHERE id = ?', [defId])
      assert.equal(Number(instRows[0].n), 0, '嵌套写必须随外层回滚（旧形状双开会把它提交掉）')
      assert.equal(Number(defRows[0].n), 0, '引擎 inTx 内的写同样随外层回滚')
    } finally {
      await cleanup()
    }
  })

  it('⑤ ext 腿（145-2②）：设计/历史/委托三表随主仓事务回滚（共用同一枚 ALS）', async () => {
    try {
      await applySchema()
      await cleanup()
      const repo = new JdbcRepository(makeAdapter(pool), new SeqIDGen())
      // ext 用另一只池（模拟集成侧两池同库）：join 走 ALS 里主仓的事务连接，与它自己的池无关
      const ext = new JdbcProcessExtRepository(makeAdapter(pool2), new SeqIDGen())
      const design: ProcessDesign = {
        id: 0, name: 'txtier-design', displayName: '事务设计', type: 'approval', icon: '',
        isDeployed: 0, remark: '', createTime: new Date(), createUser: 't',
        updateTime: new Date(), updateUser: 't',
      }
      const surrogate: ProcessSurrogate = {
        id: 0, operator: 'txtier-op', surrogate: 'txtier-agent', enabled: 1,
        createTime: new Date(), createUser: 't', updateTime: new Date(), updateUser: 't',
      }

      await assert.rejects(() => repo.withTx(async () => {
        await ext.saveDesign(design)
        await ext.saveDesignHis({ id: 0, processDesignId: design.id, content: '{"v":1}', createTime: new Date(), createUser: 't' } as ProcessDesignHis)
        await ext.saveSurrogate(surrogate)
        throw new Error('tx-ext boom')
      }), /tx-ext boom/)

      const dRows = await qPool(pool2, "SELECT COUNT(*) AS n FROM wf_process_design WHERE name = 'txtier-design'")
      const hRows = await qPool(pool2, 'SELECT COUNT(*) AS n FROM wf_process_design_his WHERE process_design_id = ?', [design.id])
      const sRows = await qPool(pool2, "SELECT COUNT(*) AS n FROM wf_process_surrogate WHERE operator = 'txtier-op'")
      assert.equal(Number(dRows[0].n), 0, '设计表随回滚（旧形状=自带第二枚 ALS 永不 run ⇒ 这条会留存）')
      assert.equal(Number(hRows[0].n), 0, '设计历史表随回滚')
      assert.equal(Number(sRows[0].n), 0, '委托表随回滚')

      // 阳性对照：同三笔在事务里正常提交 ⇒ 三表都在（防"路径本身写不进去"的假绿）
      await repo.withTx(async () => {
        await ext.saveDesign(design)
        await ext.saveDesignHis({ id: 0, processDesignId: design.id, content: '{"v":1}', createTime: new Date(), createUser: 't' } as ProcessDesignHis)
        await ext.saveSurrogate(surrogate)
      })
      assert.equal(Number((await qPool(pool2, "SELECT COUNT(*) AS n FROM wf_process_design WHERE name = 'txtier-design'"))[0].n), 1, '正常提交时设计在')
      assert.equal(Number((await qPool(pool2, "SELECT COUNT(*) AS n FROM wf_process_surrogate WHERE operator = 'txtier-op'"))[0].n), 1, '正常提交时委托在')
    } finally {
      await cleanup()
    }
  })

  it('⑥ writer 腿（C99 ⑥）：transactionAwarePool 并入动作事务随回滚消失；裸池对照逃逸留存；监听器 e2e', async () => {
    try {
      await applySchema()
      await cleanup()
      await insertDefine()
      const repo = new FlakyRepo(makeAdapter(pool), new SeqIDGen())
      const engine = new EngineImpl(repo, userProv, new SeqIDGen())
      const txPool: any = transactionAwarePool(pool2 as any)

      // 6a joined：事务内经事务感知池写探针行，随后整笔回滚 ⇒ 行消失
      await assert.rejects(() => repo.withTx(async () => {
        await txPool.execute('INSERT INTO biz_tx_probe (id, tag) VALUES (?, ?)', [1, 'txtier-joined'])
        throw new Error('writer boom')
      }), /writer boom/)
      assert.equal(Number((await qPool(pool, "SELECT COUNT(*) AS n FROM biz_tx_probe WHERE tag = 'txtier-joined'"))[0].n), 0, '经包装的写必须随事务回滚')

      // 6b escape 对照：同一位置用**裸池**写 ⇒ 自连接自动提交，回滚影响不到它（这就是要修的形态）
      await assert.rejects(() => repo.withTx(async () => {
        await pool2.execute('INSERT INTO biz_tx_probe (id, tag) VALUES (?, ?)', [2, 'txtier-escape'])
        throw new Error('writer boom')
      }), /writer boom/)
      assert.equal(Number((await qPool(pool, "SELECT COUNT(*) AS n FROM biz_tx_probe WHERE tag = 'txtier-escape'"))[0].n), 1, '裸池红样：逃逸留存＝修前形态')

      // 6c 监听器 e2e：动作进行中（门面 startAndExecute）监听器经包装写业务表，动作后段失败 ⇒ 一并回滚
      engine.setExtensions({
        listeners: [async (ev) => {
          if (ev.type === EventType.ProcessInstanceStart) {
            await txPool.execute('INSERT INTO biz_tx_probe (id, tag) VALUES (?, ?)', [3, 'txtier-listener'])
          }
        }],
      })
      const facade = new JeeflowFacade(engine, repo, undefined)
      repo.failOnAddTaskActor = true
      const res = await facade.flow('processInstance/startAndExecute', { processDefineId: DEFINE_ID, operator: 'zhangsan' })
      repo.failOnAddTaskActor = false
      assert.equal(res.code, 99999999, '动作以失败信封收场')
      assert.equal(Number((await qPool(pool, "SELECT COUNT(*) AS n FROM biz_tx_probe WHERE tag = 'txtier-listener'"))[0].n), 0, '动作内监听器写（集成侧写腿同型）必须随动作回滚')
      assert.equal(await countInstances(), 0, '动作整体回滚（实例 0）')
    } finally {
      await cleanup()
    }
  })
})
