// audit8 R77 读法一（node 腿）：可选「提交后腿」通道 EngineImpl.runAfterCommit ＋ jdbc 仓 afterCommit。
//
// 契约下限（owner 10-16 拍，spec12 §12.3.1／issues/234 §4.3）＝"监听器看到的世界＝已提交"由
// **监听器侧**承担：引擎的派发点不动（145-3 钉着"监听器随事件拿到动作事务连接"），要提交后语义就
// 自己经这条通道声明 ⇒ COMMIT 后执行、回滚整批丢弃；没有活动事务 ⇒ 立即执行（行为逐字不变）。
//
// 用法：node --import tsx --test __tests__/after_commit_r77.test.ts（真库腿连 160，与 tx-tier 同纪律）
import { after, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import mysql from 'mysql2/promise'
import { EngineImpl } from '../src/engine.js'
import { MemoryRepository } from '../src/memory.js'
import { JdbcRepository } from '../src/jdbc/index.js'
import { MysqlAdapter } from '../src/jdbc/mysql.js'
import { InstanceState, ProcessInstance } from '../src/model.js'
import type { IDGenerator, UserProvider } from '../src/spi.js'

const DB_HOST = process.env.JEFFLOW_DB_HOST ?? '192.168.1.160'
const DB_PORT = Number(process.env.JEFFLOW_DB_PORT ?? 3306)
const DB_USER = process.env.JEFFLOW_DB_USER ?? 'root'
const DB_PWD = process.env.JEFFLOW_DB_PWD ?? '8Eli#gr#AUk'

const pool: any = mysql.createPool({ host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PWD, database: 'jeeflow', charset: 'utf8mb4', connectionLimit: 3 })
// 独立取证池：回滚腿必须走与事务无关的第二条连接，否则"没落库"可能是同连接可见性假象
const pool2: any = mysql.createPool({ host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PWD, database: 'jeeflow', charset: 'utf8mb4', connectionLimit: 2 })

after(async () => {
  await pool.execute('DELETE FROM wf_process_instance WHERE id IN (?, ?)', [R77_ROLL_ID, R77_COMMIT_ID])
  await pool.end()
  await pool2.end()
})

const userProv: UserProvider = {
  async getUser(userId: string) {
    return { userId, realName: userId, deptId: 'D01', deptName: '部门', postId: 'P01', postName: '岗位' } as any
  },
}

class SeqIDGen implements IDGenerator {
  private base = Date.now() * 4000 + 7_000_000
  private n = 0
  nextId(): string { this.n += 1; return String(this.base + this.n) }
}

const engineOf = (repo: any) =>
  new EngineImpl(repo, userProv as any, new SeqIDGen(), { async eval() { return false } } as any)

const R77_ROLL_ID = '927701'
const R77_COMMIT_ID = '927702'

function mkInst(id: string): ProcessInstance {
  const now = new Date()
  return new ProcessInstance({
    id, defineId: '920007', state: InstanceState.Doing, operator: 'zhangsan',
    businessNo: `R77-${id}`, variables: { k: 'v' },
    createTime: now, updateTime: now, createUser: 't', updateUser: 't',
  })
}

async function countById(p: any, id: string): Promise<number> {
  const [rows] = await p.execute('SELECT COUNT(*) AS n FROM wf_process_instance WHERE id = ?', [id])
  return Number((rows as any[])[0].n)
}

describe('R77 提交后腿通道（issues/234 §4.3／spec12 §12.3.1）', () => {
  it('① 仓储没有这条通道（内存仓）⇒ 立即执行，行为与上一版一致', async () => {
    const repo = new MemoryRepository()
    const engine = engineOf(repo)
    let ran = 0
    await engine.runAfterCommit(() => { ran++ })
    assert.equal(ran, 1, '无活动事务／无通道时必须立即执行（"落库后"与"提交后"等价）')
  })

  it('② 载体登记成功 ⇒ 提交前不执行；flush 后恰好一次；引擎派发形状不受影响', async () => {
    const repo: any = new MemoryRepository()
    const pending: Array<() => any> = []
    repo.afterCommit = (fn: () => any) => { pending.push(fn); return true }
    const engine = engineOf(repo)
    const seen: string[] = []
    engine.setExtensions({ interceptors: [], listeners: [(evt: any) => { seen.push(`sync:${evt.type}`) }] } as any)
    let ran = 0
    await engine.runAfterCommit(() => { ran++ })
    assert.equal(ran, 0, '登记成功就不该立即执行')
    assert.equal(pending.length, 1, '应恰好登记一条提交后腿')
    for (const cb of pending) await cb()
    assert.equal(ran, 1, '提交后腿应执行且只执行一次')
    // 派发形状档：监听器（没接通道的）仍在事件到达时同步被调
    await engine.fireEvent({ type: 1, instanceId: 'x' } as any)
    assert.deepEqual(seen, ['sync:1'], 'fire 的发起点不得被通道改动（145-3 形状）')
  })

  it('③ 真库回滚探针：回滚 ⇒ 提交后腿零执行且实例行真没落库；提交 ⇒ 恰好一次', async () => {
    const repo = new JdbcRepository(new MysqlAdapter(pool), new SeqIDGen())
    const engine = engineOf(repo)
    const ran: string[] = []

    // 回滚腿
    await assert.rejects(
      () => repo.withTx(async () => {
        await repo.saveInstance(mkInst(R77_ROLL_ID))
        await engine.runAfterCommit(() => { ran.push(R77_ROLL_ID) })
        assert.equal(ran.length, 0, '提交前就跑了提交后腿')
        throw new Error('injected: R77 回滚探针')
      }),
      /injected/,
      '前置失效：注入的回滚错误没传出来（这段事务根本没跑）',
    )
    assert.deepEqual(ran, [], '回滚场景提交后腿一条都不该执行（修前无通道＝这一腿只能在事务内跑）')
    assert.equal(await countById(pool2, R77_ROLL_ID), 0, '回滚腿必须真回滚（否则上一条断言是空转）')

    // 提交腿
    await repo.withTx(async () => {
      await repo.saveInstance(mkInst(R77_COMMIT_ID))
      await engine.runAfterCommit(() => { ran.push(R77_COMMIT_ID) })
      assert.equal(ran.length, 0, '提交前就跑了提交后腿')
    })
    assert.deepEqual(ran, [R77_COMMIT_ID], '提交后腿应恰好执行一次')
    assert.equal(await countById(pool2, R77_COMMIT_ID), 1, '提交腿应落库 1 行')
  })
})
