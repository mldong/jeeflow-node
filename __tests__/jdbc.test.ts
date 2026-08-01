// JDBC（MySQL）仓储集成测试——对齐 Go/Python jdbc 测试。
//
// 前置条件：
//   - 开发服务器 MySQL（192.168.1.160:3306，库 jeeflow）
//   - 5 张 wf_* 表已建
// 测试数据固定 define ID=900004，开头清理，可重复执行。
import { after, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import mysql from 'mysql2/promise'
import { EngineImpl } from '../src/engine.js'
import { JdbcRepository, TsIDGenerator } from '../src/jdbc/index.js'
import { MysqlAdapter } from '../src/jdbc/mysql.js'
import { InstanceState, TaskState, ProcessInstance, type ProcessDefine } from '../src/model.js'
import type { IDGenerator, UserProvider } from '../src/spi.js'

const DSN = {
  host: '192.168.1.160', port: 3306, user: 'root', password: '8Eli#gr#AUk',
  database: 'jeeflow', charset: 'utf8mb4', connectionLimit: 5,
}
const DEFINE_ID = 900004
const FLOW_DIR = '../jeeflow-java/jeeflow-core/src/test/resources/flows/'

const pool = mysql.createPool(DSN)

after(async () => {
  await pool.end()
})

const userProv: UserProvider = {
  async getUser(userId) {
    return { userId, realName: userId, deptId: 'D01', deptName: '部门', postId: 'P01', postName: '岗位' }
  },
}

class SeqIDGen implements IDGenerator {
  private base = Date.now() * 1000
  private n = 0
  nextId(): number { this.n += 1; return this.base + this.n }
}

async function cleanup(): Promise<void> {
  const [conn] = [await pool.getConnection()]
  try {
    await conn.query('DELETE FROM wf_process_task_actor WHERE process_task_id IN (SELECT id FROM wf_process_task WHERE process_instance_id IN (SELECT id FROM wf_process_instance WHERE process_define_id = ?))', [DEFINE_ID])
    await conn.query('DELETE FROM wf_process_cc_instance WHERE process_instance_id IN (SELECT id FROM wf_process_instance WHERE process_define_id = ?)', [DEFINE_ID])
    await conn.query('DELETE FROM wf_process_task WHERE process_instance_id IN (SELECT id FROM wf_process_instance WHERE process_define_id = ?)', [DEFINE_ID])
    await conn.query('DELETE FROM wf_process_instance WHERE process_define_id = ?', [DEFINE_ID])
    await conn.query('DELETE FROM wf_process_define WHERE id = ?', [DEFINE_ID])
  } finally {
    conn.release()
  }
}

async function insertDefine(): Promise<void> {
  const content = readFileSync(FLOW_DIR + '01-simple.json', 'utf-8')
  const raw = JSON.parse(content)
  const now = new Date()
  await pool.execute(
    'INSERT INTO wf_process_define (id, name, display_name, type, state, content, version, create_time, create_user, update_time, update_user) VALUES (?,?,?,?,1,?,1,?,?,?,?)',
    [DEFINE_ID, 'node-simple', raw.displayName, raw.type, content, now, 'node-test', now, 'node-test'])
}

describe('JdbcRepository (MySQL 192.168.1.160 jeeflow)', () => {
  it('主链路：启动→apply→task1→结束，持久化验证', async () => {
    await cleanup()
    try {
      await insertDefine()
      const repo = new JdbcRepository(new MysqlAdapter(pool), new TsIDGenerator())
      const engine = new EngineImpl(repo, userProv, new SeqIDGen())

      // ① 启动：start → apply（发起人 zhangsan，applicant→发起人）
      const inst = await engine.startProcessInstanceById(DEFINE_ID, 'zhangsan', { amount: '1000', BUSINESS_NO: 'BIZ-NODE-001' })
      assert.equal(inst.state, InstanceState.Doing, '实例进行中')
      assert.ok(inst.businessNo, '生成业务号')

      let doing = await repo.findDoingTasks(inst.id)
      assert.deepEqual(doing.map(t => t.taskName), ['apply'], '启动产生 apply 任务')
      assert.deepEqual(doing[0].actorIds, ['zhangsan'], 'apply 参与者为发起人（applicant→发起人）')

      // ② 完成 apply（startAndExecute 语义）→ task1（leader）
      let inst2 = await engine.executeProcessTask(doing[0].id, 'zhangsan')
      let done = await repo.findDoneTasks(inst2.id)
      assert.equal(done.length, 1, 'apply 已完成')
      assert.equal(done[0].taskName, 'apply')
      assert.equal(done[0].actorId, 'zhangsan', 'apply 处理人为发起人')
      assert.ok(done[0].finishTime, 'apply 记录完成时间')
      doing = await repo.findDoingTasks(inst2.id)
      assert.deepEqual(doing.map(t => t.taskName), ['task1'], '产生 task1 待办')
      assert.deepEqual(doing[0].actorIds, ['leader'], 'task1 参与者为 leader')

      // ③ 完成 task1 → end → 实例完成
      inst2 = await engine.executeProcessTask(doing[0].id, 'leader', { comment: 'ok' })
      assert.equal(inst2.state, InstanceState.Done, '流程实例完成')

      // ④ 重新连接验证持久化
      const pool2 = mysql.createPool(DSN)
      try {
        const repo2 = new JdbcRepository(new MysqlAdapter(pool2), new TsIDGenerator())
        const reloaded = await repo2.findInstanceById(inst.id)
        assert.ok(reloaded, '重新加载实例')
        assert.equal(reloaded.state, InstanceState.Done, '持久化状态完成')
        assert.equal(reloaded.variables.amount, '1000', '变量 amount 持久化')
        const hist = await repo2.findHistoryTasks(inst.id)
        assert.equal(hist.length, 2, '历史任务 2 条')
        assert.ok(hist.every(t => t.actorIds.length > 0), '参与者关系持久化')
        const [rows] = await pool2.execute('SELECT state FROM wf_process_instance WHERE id = ?', [inst.id])
        assert.equal((rows as any[])[0].state, InstanceState.Done, '直查数据库实例已完成')
      } finally {
        await pool2.end()
      }
    } finally {
      await cleanup()
    }
  })

  it('权限负向：非参与者操作被拒，任务状态不变', async () => {
    await cleanup()
    try {
      await insertDefine()
      const repo = new JdbcRepository(new MysqlAdapter(pool), new TsIDGenerator())
      const engine = new EngineImpl(repo, userProv, new SeqIDGen())
      const inst = await engine.startProcessInstanceById(DEFINE_ID, 'zhangsan', { BUSINESS_NO: 'BIZ-NODE-002' })
      const doing = await repo.findDoingTasks(inst.id)
      await assert.rejects(
        () => engine.executeProcessTask(doing[0].id, 'hacker'),
        /not allowed/,
        '非参与者被拒',
      )
      const t = await repo.findTaskById(doing[0].id)
      assert.equal(t?.taskState, TaskState.Doing, '被拒后任务仍进行中')
    } finally {
      await cleanup()
    }
  })

  it('事务（spec §7.4）：提交 / 回滚 / 事务内绑定读', async () => {
    await cleanup()
    try {
      await insertDefine()
      const repo = new JdbcRepository(new MysqlAdapter(pool), new TsIDGenerator())

      // ① 事务内提交：实例 + 抄送同一连接落库
      await repo.withTx(async () => {
        const now = new Date()
        await repo.saveInstance(new ProcessInstance({
          id: 900005, defineId: DEFINE_ID, state: InstanceState.Doing, operator: 'zhangsan',
          businessNo: 'TXN-NODE-001', variables: { k: 'v' },
          createTime: now, updateTime: now, createUser: 't', updateUser: 't',
        }))
        await repo.createCcInstance(900005, 'zhangsan', 'lisi', 'wangwu')
        const got = await repo.findInstanceById(900005) // 事务内绑定读
        assert.ok(got, '事务内可读（连接绑定生效）')
      })
      const [[instRows], [ccRows]] = await Promise.all([
        pool.execute('SELECT COUNT(*) AS n FROM wf_process_instance WHERE id = 900005'),
        pool.execute('SELECT COUNT(*) AS n FROM wf_process_cc_instance WHERE process_instance_id = 900005'),
      ])
      assert.equal((instRows as any[])[0].n, 1, '事务提交落库')
      assert.equal((ccRows as any[])[0].n, 2, '抄送 2 条')

      // ② 事务回滚：回调抛错 → 全部回滚
      await assert.rejects(
        () => repo.withTx(async () => {
          const now = new Date()
          await repo.saveInstance(new ProcessInstance({
            id: 900006, defineId: DEFINE_ID, state: InstanceState.Doing, operator: 'zhangsan',
            createTime: now, updateTime: now, createUser: 't', updateUser: 't',
          }))
          await repo.createCcInstance(900006, 'zhangsan', 'lisi')
          throw new Error('boom')
        }),
        /boom/,
      )
      const [[instRows2], [ccRows2]] = await Promise.all([
        pool.execute('SELECT COUNT(*) AS n FROM wf_process_instance WHERE id = 900006'),
        pool.execute('SELECT COUNT(*) AS n FROM wf_process_cc_instance WHERE process_instance_id = 900006'),
      ])
      assert.equal((instRows2 as any[])[0].n, 0, '回滚后实例无残留')
      assert.equal((ccRows2 as any[])[0].n, 0, '回滚后抄送无残留')

      // 清理固定事务数据
      await pool.execute('DELETE FROM wf_process_instance WHERE id = 900005')
      await pool.execute('DELETE FROM wf_process_cc_instance WHERE process_instance_id = 900005')
    } finally {
      await cleanup()
    }
  })
})
