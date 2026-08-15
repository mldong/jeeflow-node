// MySQL 适配器（mysql2）——连接池 + `?` 占位符（与核心一致，无需转换）。
//
// 必须用 query() 而不是 execute()：mysql2 execute 走预处理协议，
// LIMIT ? / OFFSET ? 会失败（Incorrect arguments / LIMIT 被绑成字符串），
// 分页接口整段变成 facade 99999999（issues/66）。Postgres 适配器本来就走 query()。

import type { Pool, PoolConnection } from 'mysql2/promise'
import type { SqlAdapter, SqlConnection } from './shared.js'

export class MysqlConnection implements SqlConnection {
  constructor(readonly raw: PoolConnection) {}

  async execute(sql: string, args: any[]): Promise<void> {
    await this.raw.query(sql, args)
  }

  async fetchOne(sql: string, args: any[]): Promise<any | null> {
    const [rows] = await this.raw.query(sql, args)
    return (rows as any[])[0] ?? null
  }

  async fetchAll(sql: string, args: any[]): Promise<any[]> {
    const [rows] = await this.raw.query(sql, args)
    return rows as any[]
  }

  async begin(): Promise<void> {
    await this.raw.beginTransaction()
  }

  async commit(): Promise<void> {
    await this.raw.commit()
  }

  async rollback(): Promise<void> {
    await this.raw.rollback()
  }
}

export class MysqlAdapter implements SqlAdapter {
  placeholder = '?' as const

  constructor(private readonly pool: Pool) {}

  async acquire(): Promise<MysqlConnection> {
    return new MysqlConnection(await this.pool.getConnection())
  }

  async release(conn: SqlConnection): Promise<void> {
    ;(conn as MysqlConnection).raw.release()
  }
}
