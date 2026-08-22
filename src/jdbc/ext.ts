// 扩展仓储 JDBC 参考实现（v1.1.0）——流程设计 / 设计历史 / 委托代理
//
// 与 shared.ts 同一套 SqlAdapter / 占位符约定；分页为单表简单过滤（filters 字段名 EQ）。

import { AsyncLocalStorage } from 'node:async_hooks'
import {
  ProcessDesign, ProcessDesignHis, ProcessSurrogate,
} from '../model.js'
import type { IDGenerator, ProcessExtRepository, QueryCondition } from '../spi.js'
import { TsIDGenerator, rowId, type SqlAdapter, type SqlConnection } from './shared.js'

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

  async getSurrogate(operator: string, processName: string, at: Date = new Date()): Promise<ProcessSurrogate | null> {
    const hit = await this.querySurrogate(operator, processName, at)
    if (hit) return hit
    return this.querySurrogate(operator, '', at)
  }

  private async querySurrogate(operator: string, processName: string, at: Date): Promise<ProcessSurrogate | null> {
    let sql = `SELECT ${JdbcProcessExtRepository.SURROGATE_COLS} FROM wf_process_surrogate WHERE operator = ? AND enabled = 1 AND surrogate <> ?`
    const args: any[] = [operator, operator]
    if (!processName) {
      sql += " AND (process_name IS NULL OR process_name = '')"
    } else {
      sql += ' AND process_name = ?'
      args.push(processName)
    }
    if (at) {
      sql += ' AND (start_time IS NULL OR start_time <= ?) AND (end_time IS NULL OR end_time >= ?)'
      args.push(at, at)
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
