import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { actorDeleteForms } from '../src/spi.js'
import { MemoryRepository } from '../src/memory.js'
import { JdbcRepository } from '../src/jdbc/index.js'
import type { SqlAdapter, SqlConnection } from '../src/jdbc/index.js'

/**
 * 归属值**删除腿**收口为「原值 ∪ trim 值」两形并集（issues/137 §3-6 · spec 06-facade.md
 * §processTask/removeTaskActor 语义 6 ＋ §2.11 表末行「删除腿」· owner 2026-10-02 拍「两形并集」）。
 *
 * 判据逐字依据＝spec 语义 6 的仓储删除侧三件事：① 空值一律丢弃、不喂 DELETE；② 非空值同时以
 * 「原值」与「trim 值」两形进 IN（去重保序）；③ 并集为空 ⇒ 一条 DELETE 都不发（早退，不退化成
 * "清空该任务全部参与者"）。单点＝`spi.actorDeleteForms`（java `StringUtils.actorDeleteForms` 的
 * node 对应件），trim 与判空复用 `spi.normalizeActorValue` 那一枚，不抄第二份。
 *
 * 只取一头各有一种假成功（本文件两仓都钉住）：
 *  - 只取 trim 形 ⇒ 门面按语义 6 交出的历史脏行原值 `" 9101 "` 被削成 `9101`，真库 NO PAD（内存仓
 *    是列值精确比较）下删不掉而门面报成功——被摘的人待办还在；
 *  - 只取原值 ⇒ 第三方绕过门面直连仓储传 `" 8601 "` 时删不掉写侧归一后落库的规范行 `8601`
 *    （issues/142 §9.2 那一路）；且空值照喂 DELETE 会误删历史 `actor_id=''` 脏行。
 *
 * 与既有 `remove-task-actor-115.test.ts`（门面 action 全链）互补：本文件**直接调仓储删除腿**
 * （含"绕过门面直连仓储"的未 trim 入参形状），并断言 SQL 仓**库里的真实列值**。
 *
 * ⚠️ 脏行夹具一律用**前导空格**：MySQL 5.7 PAD SPACE 只忽略尾部、8.0 NO PAD 连尾部也算，SQLite
 * 默认 BINARY collation 前后空格都算——前导空格在任何排序规则下都与规范行不等，判据不会漂。
 * ⚠️ 种脏行**绕开写侧归一**（`addTaskActor`/`insertTaskActors` 会 trim＋丢空，正常路径建不出
 * `" 9101 "` 也建不出 `actor_id=''` 行）：内存仓直改 Map、SQL 仓直插库。
 */

// ═══════════════════════════════════════════════════════════════════════════
// SQLite 内嵌库适配器（node:sqlite，零依赖、不连网、不开端口）——
// 既有 jdbc.test.ts 连的是远程真库（192.168.1.160），本文件改用本栈既有的内嵌库
// （persist.test.ts / meta.test.ts 同款 node:sqlite）以便无网络也能断言真实列值。
// 占位符 `?` 与核心一致（SQLite 原生），DELETE ... IN (?) 的精确比较＝BINARY collation，
// 与 MySQL NO PAD 同语义（前导空格脏行 ≠ 规范行）。
// ═══════════════════════════════════════════════════════════════════════════

class SqliteConnection implements SqlConnection {
  constructor(private readonly db: DatabaseSync) {}
  async execute(sql: string, args: any[]): Promise<void> { this.db.prepare(sql).run(...(args as any)) }
  async fetchOne(sql: string, args: any[]): Promise<any | null> { return this.db.prepare(sql).get(...(args as any)) ?? null }
  async fetchAll(sql: string, args: any[]): Promise<any[]> { return this.db.prepare(sql).all(...(args as any)) as any[] }
  async begin(): Promise<void> { this.db.exec('BEGIN') }
  async commit(): Promise<void> { this.db.exec('COMMIT') }
  async rollback(): Promise<void> { this.db.exec('ROLLBACK') }
}

function sqliteAdapter(db: DatabaseSync): SqlAdapter {
  const conn = new SqliteConnection(db)
  return { placeholder: '?', async acquire() { return conn }, async release() {} }
}

// ── 内存仓夹具：直改私有 Map 绕开写侧归一 ──────────────────────────────────
function seedMem(repo: MemoryRepository, taskId: string, values: string[]): void {
  ;(repo as any).actors.set(taskId, [...values])
}
async function memActors(repo: MemoryRepository, taskId: string): Promise<string[]> {
  // findTaskActors 返回内部**活列表引用**，取副本再断言（否则比的是同一个数组）
  return [...(await repo.findTaskActors(taskId))]
}

// ── SQL 仓夹具：node:sqlite 内嵌库 + 直插库绕开写侧归一 ─────────────────────
let sqlSeq = 0
function sqlHarness(): { db: DatabaseSync; repo: JdbcRepository } {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE wf_process_task_actor (
    id TEXT PRIMARY KEY, process_task_id TEXT, actor_id TEXT, create_time TEXT, create_user TEXT)`)
  return { db, repo: new JdbcRepository(sqliteAdapter(db)) }
}
function seedSql(db: DatabaseSync, taskId: string, actorId: string): void {
  sqlSeq++
  db.prepare('INSERT INTO wf_process_task_actor (id, process_task_id, actor_id, create_time, create_user) VALUES (?,?,?,?,?)')
    .run(`row${sqlSeq}`, taskId, actorId, new Date().toISOString(), 'jeeflow')
}
/** 直查库里的真实列值（按插入序），不看内存对象 */
function realIds(db: DatabaseSync, taskId: string): string[] {
  const rows = db.prepare('SELECT actor_id FROM wf_process_task_actor WHERE process_task_id = ? ORDER BY rowid ASC')
    .all(taskId) as Array<{ actor_id: string }>
  return rows.map(r => r.actor_id)
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. 单点纯函数 actorDeleteForms
// ═══════════════════════════════════════════════════════════════════════════
describe('actorDeleteForms（删除腿单点 · issues/137 §3-6「原值 ∪ trim 值」两形并集）', () => {

  it('空值全丢：null/undefined/""/纯空白/制表/换行 一个都不进删除集合', () => {
    assert.deepEqual(
      actorDeleteForms([null, undefined, '', '   ', '\t', '\n', '\r\n', ' \t\n\r ']),
      [],
      '空值三形（null/undefined/空串）＋纯空白（空格/制表/换行/混合）一律丢弃')
  })

  it('带空格值产出两形且**原值在前**（原值形保住未 trim 历史脏行）', () => {
    assert.deepEqual(actorDeleteForms([' 9101 ']), [' 9101 ', '9101'], '原值形先、trim 形后')
  })

  it('已 trim 值只一份（原值==trim 形 ⇒ 去重后单条）', () => {
    assert.deepEqual(actorDeleteForms(['9101']), ['9101'])
  })

  it('跨元素去重：不同元素的 trim 形相同 ⇒ trim 形只留一份，原值形各自保留', () => {
    // '9101' 与 ' 9101 ' 的 trim 形都是 '9101' ⇒ 只出现一次；两个原值形（'9101' / ' 9101 '）各留
    assert.deepEqual(actorDeleteForms(['9101', ' 9101 ', '9101']), ['9101', ' 9101 '])
  })

  it('不同原值形各自保留（" 9101 " 与 "  9101  " 是两种原值形，**不按 trim 折叠**）', () => {
    assert.deepEqual(actorDeleteForms([' 9101 ', '  9101  ']), [' 9101 ', '9101', '  9101  '])
  })

  it('反向哨兵："0"/"00" 是合法 id 必须留下且互不折叠（严禁 filter(Boolean)/!x 假值判据）', () => {
    assert.deepEqual(actorDeleteForms(['0', '00']), ['0', '00'], '"0" 与 "00" 是两个人')
    // ' 0 ' 原值形 ' 0 ' 保留、trim 形 '0' 已在集合 ⇒ 只补原值形
    assert.deepEqual(actorDeleteForms(['0', ' 0 ']), ['0', ' 0 '])
  })

  it('保序：按入参顺序展开，同一元素原值形先于 trim 形', () => {
    assert.deepEqual(actorDeleteForms([' b ', 'a']), [' b ', 'b', 'a'])
  })

  it('入参 null / undefined / 空数组 / 非数组 ⇒ 空数组（调用方据此早退，一条 DELETE 都不发）', () => {
    assert.deepEqual(actorDeleteForms(null), [])
    assert.deepEqual(actorDeleteForms(undefined), [])
    assert.deepEqual(actorDeleteForms([]), [])
    assert.deepEqual(actorDeleteForms('not-an-array' as any), [], '非数组按"没有归属人"处理')
  })

  it('null/undefined 元素**绝不**被 String() 串化成 "null"/"undefined" 落进删除集合', () => {
    const forms = actorDeleteForms([null, undefined, 'x'])
    assert.ok(!forms.includes('null'), 'null 不得串化成字面 "null"')
    assert.ok(!forms.includes('undefined'), 'undefined 不得串化成字面 "undefined"')
    assert.deepEqual(forms, ['x'])
  })

  it('混合：空值穿插在正常值之间，只丢空值、正常值两形展开且保序', () => {
    assert.deepEqual(
      actorDeleteForms(['', ' 8601 ', null, '8601', '   ', undefined, '\t']),
      [' 8601 ', '8601'],
      "' 8601 '→原值+trim；后续 '8601' 的原值/trim 形都已在集合 ⇒ 不重复"
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. 内存仓删除腿（直接调仓储，含绕门面直连的未 trim 入参形状）
// ═══════════════════════════════════════════════════════════════════════════
describe('MemoryRepository.removeTaskActor（内存仓删除腿 · 两形并集）', () => {

  it('N 未 trim 脏行 " 9101 " 按**原值形**真删掉（反面＝trim 派假成功）', async () => {
    const repo = new MemoryRepository()
    seedMem(repo, 't1', [' 9101 ', 'leader'])
    await repo.removeTaskActor('t1', [' 9101 '])
    assert.deepEqual(await memActors(repo, 't1'), ['leader'], '脏行 " 9101 " 必须真消失，leader 不动')
  })

  it('N 规范行 8601 被绕门面传来的 " 8601 " 按 **trim 形**删掉（issues/142 §9.2 既有判据）', async () => {
    const repo = new MemoryRepository()
    seedMem(repo, 't1', ['8601', 'leader'])
    await repo.removeTaskActor('t1', [' 8601 '])   // 第三方直连仓储、未 trim
    assert.deepEqual(await memActors(repo, 't1'), ['leader'], '规范行 8601 必须被 trim 形命中删掉')
  })

  it('N 脏行与规范行并存 ⇒ 两行都摘掉，其余参与人一行不动', async () => {
    const repo = new MemoryRepository()
    seedMem(repo, 't1', [' 9101 ', '9101', 'leader', '9002'])
    await repo.removeTaskActor('t1', [' 9101 '])
    assert.deepEqual(await memActors(repo, 't1'), ['leader', '9002'],
      '脏行 " 9101 "（原值形）＋规范行 9101（trim 形）都摘掉；leader/9002 一行不动')
  })

  it('P 空值入参不得删掉 actor_id="" 脏行（空值不喂删除集合）', async () => {
    const repo = new MemoryRepository()
    seedMem(repo, 't1', ['', '   ', 'leader'])
    await repo.removeTaskActor('t1', ['leader', '', '   ', null as any])
    assert.deepEqual(await memActors(repo, 't1'), ['', '   '],
      'leader 摘掉；空串/纯空白脏行必须原样还在（空值若喂进删除集合会替脏数据做掉唯一痕迹）')
  })

  it('P 全空入参（[""]／[]／null／纯空白／[null,undefined]）⇒ 零删除，不得清空全部参与者', async () => {
    for (const arg of [[''], [], null, ['   '], [null, undefined], ['\t']] as any[]) {
      const repo = new MemoryRepository()
      seedMem(repo, 't1', ['leader', '9002'])
      await repo.removeTaskActor('t1', arg)
      assert.deepEqual(await memActors(repo, 't1'), ['leader', '9002'],
        `全空入参 ${JSON.stringify(arg) ?? 'null'} 一个都不许删（并集为空 ⇒ 早退）`)
    }
  })

  it('null 元素不得被串化成 "null" 再去匹配（库里真有字面 "null" 行也不动）', async () => {
    const repo = new MemoryRepository()
    seedMem(repo, 't1', ['null', 'leader'])   // 假设历史脏行字面量 "null"
    await repo.removeTaskActor('t1', [null as any, 'leader'])
    assert.deepEqual(await memActors(repo, 't1'), ['null'],
      'leader 摘掉；字面 "null" 行不被 null 元素误删（null 没被串化成 "null"）')
  })

  it('反向哨兵：删 "0" 不得连带删 "00"（两个人）', async () => {
    const repo = new MemoryRepository()
    seedMem(repo, 't1', ['0', '00', 'leader'])
    await repo.removeTaskActor('t1', ['0'])
    assert.deepEqual(await memActors(repo, 't1'), ['00', 'leader'], '"0" 摘掉，"00" 是另一个人必须留下')
  })

  it('非参与者静默忽略；任务不存在 ⇒ 零操作不抛异常', async () => {
    const repo = new MemoryRepository()
    seedMem(repo, 't1', ['leader'])
    await repo.removeTaskActor('t1', ['ghost'])        // 非参与者
    assert.deepEqual(await memActors(repo, 't1'), ['leader'], '非参与者静默忽略')
    await repo.removeTaskActor('no-such-task', ['x'])  // 任务不存在
    assert.deepEqual(await memActors(repo, 'no-such-task'), [], '不存在的任务 ⇒ 零参与者、不抛异常')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. SQL 仓删除腿（node:sqlite 内嵌库，断言打**库里的真实列值**）
// ═══════════════════════════════════════════════════════════════════════════
describe('JdbcRepository.removeTaskActor（SQL 仓删除腿 · SQLite 真实列值取证）', () => {

  it('N 未 trim 脏行 " 9101 " 按**原值形**真删掉（真实列值取证）', async () => {
    const { db, repo } = sqlHarness()
    seedSql(db, 't1', ' 9101 ')
    seedSql(db, 't1', 'leader')
    await repo.removeTaskActor('t1', [' 9101 '])
    assert.deepEqual(realIds(db, 't1'), ['leader'],
      '库里 " 9101 " 行必须真消失（BINARY/NO PAD 下只有原值形命中）')
  })

  it('N 规范行 8601 被 " 8601 " 按 **trim 形**删掉（issues/142 §9.2 既有判据）', async () => {
    const { db, repo } = sqlHarness()
    seedSql(db, 't1', '8601')
    seedSql(db, 't1', 'leader')
    await repo.removeTaskActor('t1', [' 8601 '])
    assert.deepEqual(realIds(db, 't1'), ['leader'], '规范行 8601 必须被 trim 形命中删掉')
  })

  it('N 脏行与规范行并存 ⇒ 两行都摘掉，其余一行不动', async () => {
    const { db, repo } = sqlHarness()
    seedSql(db, 't1', ' 9101 ')
    seedSql(db, 't1', '9101')
    seedSql(db, 't1', 'leader')
    seedSql(db, 't1', '9002')
    await repo.removeTaskActor('t1', [' 9101 '])
    assert.deepEqual(realIds(db, 't1'), ['leader', '9002'],
      '脏行（原值形）＋规范行（trim 形）都摘掉；leader/9002 一行不动')
  })

  it('P 空值入参不得删掉 actor_id="" 脏行', async () => {
    const { db, repo } = sqlHarness()
    seedSql(db, 't1', '')
    seedSql(db, 't1', '   ')
    seedSql(db, 't1', 'leader')
    await repo.removeTaskActor('t1', ['leader', '', '   ', null as any])
    assert.deepEqual(realIds(db, 't1'), ['', '   '], 'leader 摘掉；空串/纯空白脏行原样还在')
  })

  it('P 全空入参（[""]／[]／null）⇒ 一条 DELETE 都不发（早退，不退化成 IN () 语法错），参与者全留', async () => {
    for (const arg of [[''], [], null, ['   '], [null, undefined]] as any[]) {
      const { db, repo } = sqlHarness()
      seedSql(db, 't1', 'leader')
      seedSql(db, 't1', '9002')
      await repo.removeTaskActor('t1', arg)   // 若没早退，IN () 会抛 SQL 语法错
      assert.deepEqual(realIds(db, 't1'), ['leader', '9002'],
        `全空入参 ${JSON.stringify(arg) ?? 'null'} 不得清空参与者`)
    }
  })

  it('null 元素不得被串化成 "null" 再去匹配（库里真有字面 "null" 行也不动）', async () => {
    const { db, repo } = sqlHarness()
    seedSql(db, 't1', 'null')
    seedSql(db, 't1', 'leader')
    await repo.removeTaskActor('t1', [null as any, 'leader'])
    assert.deepEqual(realIds(db, 't1'), ['null'], 'leader 摘掉；字面 "null" 行不被 null 元素误删')
  })

  it('反向哨兵：删 "0" 不得连带删 "00"（BINARY 精确比较，两个人）', async () => {
    const { db, repo } = sqlHarness()
    seedSql(db, 't1', '0')
    seedSql(db, 't1', '00')
    seedSql(db, 't1', 'leader')
    await repo.removeTaskActor('t1', ['0'])
    assert.deepEqual(realIds(db, 't1'), ['00', 'leader'], '"0" 摘掉，"00" 是另一个人必须留下')
  })

  it('非参与者静默忽略；任务不存在 ⇒ 零操作不抛异常', async () => {
    const { db, repo } = sqlHarness()
    seedSql(db, 't1', 'leader')
    await repo.removeTaskActor('t1', ['ghost'])
    assert.deepEqual(realIds(db, 't1'), ['leader'], '非参与者静默忽略')
    await repo.removeTaskActor('no-such-task', ['x'])
    assert.deepEqual(realIds(db, 'no-such-task'), [], '不存在的任务 ⇒ 零行、不抛异常')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. 两仓同一条判据、同一个答案（issues/117 场景 27 那把尺子）
// ═══════════════════════════════════════════════════════════════════════════
describe('两仓删除腿同判据同答案（issues/117 场景 27）', () => {

  const scenarios: Array<{ seed: string[]; del: any[]; expect: string[]; why: string }> = [
    { seed: [' 9101 ', '9101', 'leader'], del: [' 9101 '], expect: ['leader'], why: '脏行＋规范行同摘（两形并集）' },
    { seed: ['8601', 'leader'], del: [' 8601 '], expect: ['leader'], why: 'trim 形命中规范行（142 §9.2）' },
    { seed: ['', '   ', 'leader'], del: ['leader', ''], expect: ['', '   '], why: '空值不喂删除、脏行保留' },
    { seed: ['0', '00', 'leader'], del: ['0'], expect: ['00', 'leader'], why: '"0"/"00" 两个人' },
    { seed: ['null', 'leader'], del: [null, 'leader'], expect: ['null'], why: 'null 不串化成 "null"' },
    { seed: ['leader', '9002'], del: ['', null], expect: ['leader', '9002'], why: '全空入参零删除' },
  ]

  for (const s of scenarios) {
    it(`内存仓 ≡ SQL 仓：${s.why}`, async () => {
      // 内存仓
      const mem = new MemoryRepository()
      seedMem(mem, 't1', s.seed)
      await mem.removeTaskActor('t1', s.del as any)
      const memLeft = await memActors(mem, 't1')

      // SQL 仓
      const { db, repo } = sqlHarness()
      for (const v of s.seed) seedSql(db, 't1', v)
      await repo.removeTaskActor('t1', s.del as any)
      const sqlLeft = realIds(db, 't1')

      assert.deepEqual(sqlLeft, memLeft, `两仓答案必须逐字一致（seed=${JSON.stringify(s.seed)} del=${JSON.stringify(s.del)}）`)
      assert.deepEqual(memLeft, s.expect, `结果符合预期：${s.why}`)
    })
  }
})
