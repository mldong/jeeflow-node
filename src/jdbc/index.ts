// JDBC 仓储（多数据库）——共享核心 + 数据库适配器
//
// - JdbcRepository / TsIDGenerator / SqlAdapter（共享核心，见 shared.ts）
// - MysqlAdapter（mysql2，`?` 原生）/ PostgresAdapter（pg，`$n`）

export {
  JdbcRepository,
  TsIDGenerator,
  convertPlaceholder,
  repeatPh,
  // audit8 145-2：集成侧写腿并入引擎事务的两个公开入口（C99 ⑥ node 腿）
  currentTxConnection,
  transactionAwarePool,
  type SqlAdapter,
  type SqlConnection,
} from './shared.js'
export { MysqlAdapter, MysqlConnection } from './mysql.js'
export { PostgresAdapter, PostgresConnection } from './postgres.js'
