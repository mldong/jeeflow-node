// PostgreSQL 适配器（pg）——连接池 + `$n` 占位符。
//
// > 已在开发服务器实测（PostgreSQL 16，Docker mldong-pg）。
// > pg 无 beginTransaction API，直接执行 BEGIN/COMMIT/ROLLBACK；
// > 其余接口与 mysql.ts 对齐——核心 SQL 由 shared.convertPlaceholder 统一转换。

import type { Pool, PoolClient } from 'pg'
import type { SqlAdapter, SqlConnection } from './shared.js'

export class PostgresConnection implements SqlConnection {
  constructor(readonly raw: PoolClient) {}

  async execute(sql: string, args: any[]): Promise<void> {
    await this.raw.query(sql, args)
  }

  async fetchOne(sql: string, args: any[]): Promise<any | null> {
    const r = await this.raw.query(sql, args)
    return r.rows[0] ?? null
  }

  async fetchAll(sql: string, args: any[]): Promise<any[]> {
    const r = await this.raw.query(sql, args)
    return r.rows
  }

  async begin(): Promise<void> {
    await this.raw.query('BEGIN')
  }

  async commit(): Promise<void> {
    await this.raw.query('COMMIT')
  }

  async rollback(): Promise<void> {
    await this.raw.query('ROLLBACK')
  }
}

export class PostgresAdapter implements SqlAdapter {
  placeholder = '$n' as const

  constructor(private readonly pool: Pool) {}

  async acquire(): Promise<PostgresConnection> {
    return new PostgresConnection(await this.pool.connect())
  }

  async release(conn: SqlConnection): Promise<void> {
    ;(conn as PostgresConnection).raw.release()
  }
}
