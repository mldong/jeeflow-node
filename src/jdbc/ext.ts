// 扩展仓储 JDBC 参考实现（v1.1.0）——流程设计 / 设计历史 / 委托代理
//
// 与 shared.ts 同一套 SqlAdapter / 占位符约定；分页为单表简单过滤（filters 字段名 EQ）。

import { AsyncLocalStorage } from 'node:async_hooks'
import {
  ProcessDesign, ProcessDesignHis, ProcessSurrogate,
} from '../model.js'
import type { IDGenerator, ProcessExtRepository, QueryCondition } from '../spi.js'
import { TsIDGenerator, rowId, type SqlAdapter, type SqlConnection } from './shared.js'
import { surrogateIsEffective, surrogateTimeMs } from '../surrogate-rule.js'

const txStore = new AsyncLocalStorage<SqlConnection>()

export class JdbcProcessExtRepository implements ProcessExtRepository {
  constructor(
    private readonly adapter: SqlAdapter,
    private readonly idGen: IDGenerator = new TsIDGenerator(),
  ) {}

  private sql(s: string): string {
    if (this.adapter.placeholder === '$n') {
      let i = 0
      return s.replace(/\?/g, () => `$${++i}`)
    }
    return s
  }

  private async c(): Promise<SqlConnection> {
    return txStore.getStore() ?? (await this.adapter.acquire())
  }

  private async done(conn: SqlConnection): Promise<void> {
    if (!txStore.getStore()) await this.adapter.release(conn)
  }

  // ── 流程设计 ─────────────────────────────────────────────────────────────

  private static DESIGN_COLS =
    'id, name, display_name, type, icon, is_deployed, remark, create_time, create_user, update_time, update_user'

  async findDesignById(id: string): Promise<ProcessDesign | null> {
    const conn = await this.c()
    try {
      const row = await conn.fetchOne(this.sql(
        `SELECT ${JdbcProcessExtRepository.DESIGN_COLS} FROM wf_process_design WHERE id = ?`), [id])
      return row ? this.mapDesign(row) : null
    } finally {
      await this.done(conn)
    }
  }

  async saveDesign(d: ProcessDesign): Promise<void> {
    if (!d.id) d.id = this.idGen.nextId()
    const now = new Date()
    if (!d.createTime) d.createTime = now
    if (!d.updateTime) d.updateTime = now
    const conn = await this.c()
    try {
      await conn.execute(this.sql(
        'INSERT INTO wf_process_design (id, name, display_name, type, icon, is_deployed, remark, ' +
        'create_time, create_user, update_time, update_user) VALUES (?,?,?,?,?,?,?,?,?,?,?)'),
        [d.id, d.name, d.displayName, d.type, d.icon ?? null, d.isDeployed, d.remark ?? null,
          d.createTime, d.createUser, d.updateTime, d.updateUser])
    } finally {
      await this.done(conn)
    }
  }

  async updateDesign(d: ProcessDesign): Promise<void> {
    const conn = await this.c()
    try {
      await conn.execute(this.sql(
        'UPDATE wf_process_design SET name=?, display_name=?, type=?, icon=?, is_deployed=?, ' +
        'remark=?, update_time=?, update_user=? WHERE id=?'),
        [d.name, d.displayName, d.type, d.icon ?? null, d.isDeployed, d.remark ?? null,
          new Date(), d.updateUser, d.id])
    } finally {
      await this.done(conn)
    }
  }

  async removeDesign(id: string): Promise<void> {
    const conn = await this.c()
    try {
      await conn.execute(this.sql('DELETE FROM wf_process_design WHERE id=?'), [id])
      await conn.execute(this.sql('DELETE FROM wf_process_design_his WHERE process_design_id=?'), [id])
    } finally {
      await this.done(conn)
    }
  }

  async pageDesigns(pageNum = 1, pageSize = 10, filters?: Record<string, any>, conditions?: QueryCondition[]): Promise<[ProcessDesign[], number]> {
    let sql = `SELECT ${JdbcProcessExtRepository.DESIGN_COLS} FROM wf_process_design t WHERE 1=1`
    let countSql = 'SELECT COUNT(*) FROM wf_process_design t WHERE 1=1'
    const args: any[] = []
    const args2: any[] = []
    for (const [col, val] of Object.entries(filters ?? {})) {
      if (['name', 'display_name', 'type'].includes(col)) {
        sql += ` AND t.${col} = ?`
        countSql += ` AND t.${col} = ?`
        args.push(val)
        args2.push(val)
      }
    }
    // m_ 条件（issues/05-5）：LIKE/EQ 等走白名单
    const cond = this.buildExtWhere(conditions ?? [], JdbcProcessExtRepository.DESIGN_WHITELIST)
    sql += cond.sql
    countSql += cond.sql
    args.push(...cond.params)
    args2.push(...cond.params)
    const conn = await this.c()
    try {
      const countRow = await conn.fetchOne(this.sql(countSql), args2)
      const total = countRow ? Number(Object.values(countRow)[0]) : 0
      sql += ' ORDER BY t.id DESC LIMIT ? OFFSET ?'
      args.push(pageSize, (pageNum - 1) * pageSize)
      const rows = await conn.fetchAll(this.sql(sql), args)
      return [rows.map(r => this.mapDesign(r)), total]
    } finally {
      await this.done(conn)
    }
  }

  // m_ 条件 WHERE 构建（issues/05-5，白名单 + 参数化）
  private buildExtWhere(conditions: QueryCondition[], whitelist: Set<string>): { sql: string; params: any[] } {
    let sql = ''
    const params: any[] = []
    for (const c of conditions) {
      if (!whitelist.has(c.column)) continue
      const val = c.value
      if (val == null || val === '') continue
      switch (c.operator.toUpperCase()) {
        case 'EQ': sql += ` AND ${c.column} = ?`; params.push(val); break
        case 'LIKE': sql += ` AND ${c.column} LIKE ?`; params.push(`%${val}%`); break
        case 'LLIKE': sql += ` AND ${c.column} LIKE ?`; params.push(`%${val}`); break
        case 'RLIKE': sql += ` AND ${c.column} LIKE ?`; params.push(`${val}%`); break
        case 'IN': {
          if (Array.isArray(val) && val.length > 0) {
            const marks = val.map(() => '?').join(',')
            sql += ` AND ${c.column} IN (${marks})`
            params.push(...val)
          }
          break
        }
      }
    }
    return { sql, params }
  }

  private static readonly DESIGN_WHITELIST = new Set([
    't.id', 't.name', 't.display_name', 't.type', 't.is_deployed', 't.remark',
    't.create_time', 't.update_time',
  ])

  private static readonly SURROGATE_WHITELIST = new Set([
    't.id', 't.process_name', 't.operator', 't.surrogate', 't.enabled',
    't.start_time', 't.end_time', 't.create_time', 't.update_time',
  ])

  // ── 设计历史 ─────────────────────────────────────────────────────────────

  async saveDesignHis(his: ProcessDesignHis): Promise<void> {
    if (!his.id) his.id = this.idGen.nextId()
    if (!his.createTime) his.createTime = new Date()
    const conn = await this.c()
    try {
      await conn.execute(this.sql(
        'INSERT INTO wf_process_design_his (id, process_design_id, content, create_time, create_user) VALUES (?,?,?,?,?)'),
        [his.id, his.processDesignId, his.content, his.createTime, his.createUser])
    } finally {
      await this.done(conn)
    }
  }

  async listDesignHis(designId: string): Promise<ProcessDesignHis[]> {
    const conn = await this.c()
    try {
      const rows = await conn.fetchAll(this.sql(
        'SELECT id, process_design_id, content, create_time, create_user FROM wf_process_design_his WHERE process_design_id = ? ORDER BY id DESC'),
        [designId])
      return rows.map(r => ({
        id: rowId(r.id), processDesignId: rowId(r.process_design_id),
        content: r.content ? Buffer.from(r.content).toString('utf8') : '',
        createTime: r.create_time, createUser: rowId(r.create_user),
      }))
    } finally {
      await this.done(conn)
    }
  }

  // ── 委托代理 ─────────────────────────────────────────────────────────────

  private static SURROGATE_COLS =
    'id, process_name, operator, surrogate, start_time, end_time, enabled, create_time, create_user, update_time, update_user'

  async findSurrogateById(id: string): Promise<ProcessSurrogate | null> {
    const conn = await this.c()
    try {
      const row = await conn.fetchOne(this.sql(
        `SELECT ${JdbcProcessExtRepository.SURROGATE_COLS} FROM wf_process_surrogate WHERE id = ?`), [id])
      return row ? this.mapSurrogate(row) : null
    } finally {
      await this.done(conn)
    }
  }

  async saveSurrogate(s: ProcessSurrogate): Promise<void> {
    if (!s.id) s.id = this.idGen.nextId()
    const now = new Date()
    if (!s.createTime) s.createTime = now
    if (!s.updateTime) s.updateTime = now
    // 显式 enabled=0 是合法值（停用委托）；缺省由门面处理（对齐 Java/Go/Python，issues/82-7）
    const conn = await this.c()
    try {
      await conn.execute(this.sql(
        'INSERT INTO wf_process_surrogate (id, process_name, operator, surrogate, start_time, ' +
        'end_time, enabled, create_time, create_user, update_time, update_user) VALUES (?,?,?,?,?,?,?,?,?,?,?)'),
        [s.id, s.processName ?? null, s.operator, s.surrogate, s.startTime ?? null, s.endTime ?? null,
          s.enabled, s.createTime, s.createUser, s.updateTime, s.updateUser])
    } finally {
      await this.done(conn)
    }
  }

  async updateSurrogate(s: ProcessSurrogate): Promise<void> {
    const conn = await this.c()
    try {
      await conn.execute(this.sql(
        'UPDATE wf_process_surrogate SET process_name=?, operator=?, surrogate=?, start_time=?, ' +
        'end_time=?, enabled=?, update_time=?, update_user=? WHERE id=?'),
        [s.processName ?? null, s.operator, s.surrogate, s.startTime ?? null, s.endTime ?? null,
          s.enabled, new Date(), s.updateUser, s.id])
    } finally {
      await this.done(conn)
    }
  }

  async removeSurrogate(id: string): Promise<void> {
    const conn = await this.c()
    try {
      await conn.execute(this.sql('DELETE FROM wf_process_surrogate WHERE id=?'), [id])
    } finally {
      await this.done(conn)
    }
  }

  async pageSurrogates(pageNum = 1, pageSize = 10, filters?: Record<string, any>, conditions?: QueryCondition[]): Promise<[ProcessSurrogate[], number]> {
    let sql = `SELECT ${JdbcProcessExtRepository.SURROGATE_COLS} FROM wf_process_surrogate t WHERE 1=1`
    let countSql = 'SELECT COUNT(*) FROM wf_process_surrogate t WHERE 1=1'
    const args: any[] = []
    const args2: any[] = []
    for (const [col, val] of Object.entries(filters ?? {})) {
      if (['operator', 'surrogate', 'process_name', 'enabled'].includes(col)) {
        sql += ` AND t.${col} = ?`
        countSql += ` AND t.${col} = ?`
        args.push(val)
        args2.push(val)
      }
    }
    // m_ 条件（issues/05-5）
    const cond = this.buildExtWhere(conditions ?? [], JdbcProcessExtRepository.SURROGATE_WHITELIST)
    sql += cond.sql
    countSql += cond.sql
    args.push(...cond.params)
    args2.push(...cond.params)
    const conn = await this.c()
    try {
      const countRow = await conn.fetchOne(this.sql(countSql), args2)
      const total = countRow ? Number(Object.values(countRow)[0]) : 0
      sql += ' ORDER BY t.id DESC LIMIT ? OFFSET ?'
      args.push(pageSize, (pageNum - 1) * pageSize)
      const rows = await conn.fetchAll(this.sql(sql), args)
      return [rows.map(r => this.mapSurrogate(r)), total]
    } finally {
      await this.done(conn)
    }
  }

  /**
   * 生效委托查询（issues/116 判据 a~d 基准实现 + issues/123 的取行/裁决顺序）：
   *  a. 作用域：先在该流程名作用域内取记录，该作用域**一条都没有**才兜底
   *     `process_name IS NULL OR = ''`（全流程委托）；精确作用域里只要有记录就由它裁决；
   *  然后由 `surrogateIsEffective` 裁决**这一条**：
   *  d. enabled 严格 1（'1'/1 同结论，NULL 不生效）、c. 自委托过滤、
   *  b. 时间窗 start<=at<=end（任一侧 NULL = 该侧不限；`at` 传 null 则整段跳过窗比较）。
   *
   * ⚠️ 旧形状是 `WHERE operator=? AND enabled=1 AND surrogate<>? AND 窗口… ORDER BY id DESC LIMIT 1`
   * ——先滤生效再取最新，等于"历史上留过一条窗内且 enabled=1 的记录就永久生效"，用户随后
   * 新建的窗外 / enabled=0 / 脏值 / 自委托记录全都判不动它（issues/123，13 栈 L2-17/L2-18 全红）。
   * 现在 WHERE 里**不带**任何生效判据，只 `ORDER BY id DESC LIMIT 1` 取最新一条；
   * 最新一条不生效 ⇒ 同层内不回落更旧那条，转看全流程作用域的最新一条；两层都判否才返回 null。
   * 内存仓须给出同结论（MemoryExtRepository.getSurrogate，共用 src/surrogate-rule.ts）。
   */
  async getSurrogate(operator: string, processName: string, at: Date = new Date()): Promise<ProcessSurrogate | null> {
    const name = processName ?? ''
    const ms = surrogateTimeMs(at)
    let newest = await this.queryNewestSurrogate(operator, name)
    if (!surrogateIsEffective(newest, operator, ms) && name) {
      // 精确作用域判否（含池空）⇒ 仍要看全流程作用域的最新一条（条款 1.4 后半句）
      newest = await this.queryNewestSurrogate(operator, '')
    }
    return surrogateIsEffective(newest, operator, ms) ? newest : null
  }

  /** 该授权人在指定流程作用域内**最新的一条**委托：只排序取首行，不滤任何生效判据。
   *  processName 为 '' = 全流程委托作用域（process_name IS NULL OR = ''）。 */
  private async queryNewestSurrogate(operator: string, processName: string): Promise<ProcessSurrogate | null> {
    let sql = `SELECT ${JdbcProcessExtRepository.SURROGATE_COLS} FROM wf_process_surrogate WHERE operator = ?`
    const args: any[] = [operator]
    if (!processName) {
      sql += " AND (process_name IS NULL OR process_name = '')"
    } else {
      sql += ' AND process_name = ?'
      args.push(processName)
    }
    sql += ' ORDER BY id DESC LIMIT 1'
    const conn = await this.c()
    try {
      const rows = await conn.fetchAll(this.sql(sql), args)
      return rows.length > 0 ? this.mapSurrogate(rows[0]) : null
    } finally {
      await this.done(conn)
    }
  }

  // ── 行映射 ───────────────────────────────────────────────────────────────

  private mapDesign(row: any): ProcessDesign {
    return {
      id: rowId(row.id), name: row.name, displayName: row.display_name, type: row.type,
      icon: row.icon, isDeployed: row.is_deployed, remark: row.remark,
      createTime: row.create_time, createUser: rowId(row.create_user),
      updateTime: row.update_time, updateUser: rowId(row.update_user),
    }
  }

  private mapSurrogate(row: any): ProcessSurrogate {
    return {
      id: rowId(row.id), processName: row.process_name, operator: row.operator, surrogate: row.surrogate,
      startTime: row.start_time, endTime: row.end_time, enabled: row.enabled,
      createTime: row.create_time, createUser: rowId(row.create_user),
      updateTime: row.update_time, updateUser: rowId(row.update_user),
    }
  }
}
