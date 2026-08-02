# SPI 实现指南

> 引擎核心零依赖：仓储、用户、ID、表达式全部走 SPI（`src/spi.ts`）。接入自己的业务时实现这些接口，构造 `EngineImpl` 时注入。

## ProcessRepository（必须）

仓储是唯一必须实现的 SPI，映射 [SPEC §2](../../spec/) 的 5 张表（`wf_process_define/instance/task/task_actor/cc_instance`）：

```ts
interface ProcessRepository {
  findDefineById(id: number): Promise<ProcessDefine | null>
  findInstanceById(id: number): Promise<ProcessInstance | null>
  saveInstance(inst: ProcessInstance): Promise<void>
  updateInstance(inst: ProcessInstance): Promise<void>
  findTaskById(id: number): Promise<ProcessTask | null>
  saveTask(task: ProcessTask): Promise<void>
  updateTask(task: ProcessTask): Promise<void>
  findDoingTasks(instanceId: number, taskNames?: string[]): Promise<ProcessTask[]>
  findDoneTasks(instanceId: number, taskNames?: string[]): Promise<ProcessTask[]>
  findHistoryTasks(instanceId: number): Promise<ProcessTask[]>
  findTaskActors(taskId: number): Promise<string[]>
  addTaskActor(taskId: number, actors: string[]): Promise<void>
  removeTaskActor(taskId: number, actors: string[]): Promise<void>
  createCcInstance(...args: any[]): Promise<void>
  updateCcStatus(...args: any[]): Promise<void>
}
```

> 开箱即用：
> - `MemoryRepository`（`src/memory.ts`）供演示/测试；
> - **`JdbcRepository`（`src/jdbc/`）— 多数据库 JDBC 实现**：共享核心 `shared.ts`（SQL 逻辑唯一维护点）+ 每库一个薄适配器。按库装驱动（mysql2 / pg 均为 optionalDependencies）：

```ts
// MySQL（npm i mysql2）
import mysql from 'mysql2/promise'
import { JdbcRepository } from '@mldong/jeeflow/jdbc'
import { MysqlAdapter } from '@mldong/jeeflow/mysql'

const pool = mysql.createPool({ host: '127.0.0.1', user: 'root', password: 'pwd', database: 'jeeflow' })
const repo = new JdbcRepository(new MysqlAdapter(pool))  // 关系表主键用内置时间戳 ID 生成器

// PostgreSQL（npm i pg）
// import { Pool } from 'pg'
// import { PostgresAdapter } from '@mldong/jeeflow/postgres'
// const pool = new Pool({ host: '127.0.0.1', user: 'root', password: 'pwd', database: 'jeeflow' })
// const repo = new JdbcRepository(new PostgresAdapter(pool))
```

> **新增数据库** = 写一个适配器（约 80 行，参考 `src/jdbc/mysql.ts`）：实现
> `SqlAdapter`（占位符风格 + acquire/release）+ 连接包装（execute/fetchOne/fetchAll/
> begin/commit/rollback）。SQL 核心统一用 `?` 占位符，由适配器转换
> （MySQL `?` 原生 / PostgreSQL `$n`）。建表 SQL **各语言自带**（`tests/schema/schema-<db>.sql`，使用者单语言下载即用）。

仓储方法自动映射 `wf_*` 5 张表（spec §2）。`content` 为流程定义 JSON，`variable` 为变量 JSON。

**事务（spec §7.4）**：`withTx` 用 `AsyncLocalStorage` 把事务连接绑定到当前异步上下文，回调内所有仓储调用走同一连接；异常自动回滚：

```ts
await repo.withTx(async () => {
  await repo.saveInstance(inst)
  await repo.createCcInstance(inst.id, 'zhangsan', 'lisi', 'wangwu')
})
```

> 约定：**业务层是事务 owner**——先 `withTx` 再调引擎方法，引擎核心不感知事务。

## UserProvider（可选）

一次返回用户全部信息，引擎注入 `u_*` 变量：

```ts
const userProv: UserProvider = {
  async getUser(userId: string) {
    return { userId, realName: '张三', deptId: 'D01', deptName: '研发部', postId: 'P01', postName: '工程师' }
  },
}
```

## IDGenerator / ExpressionEvaluator（可选）

```ts
const idGen: IDGenerator = { nextId: () => Date.now() * 1000 + Math.floor(Math.random() * 1000) }

const exprEval: ExpressionEvaluator = {
  async eval(expr: string, vars: Record<string, any>) {
    return evalExpr(expr, vars)  // 简易比较器即可
  },
}
```

## 示例：最小接入

```ts
const engine = new EngineImpl(new MyRepository(), userProv, idGen, exprEval)
const inst = await engine.startProcessInstanceById(defineId, operator, args)
```

## 集成测试

`__tests__/jdbc.test.ts` **双库可跑**（同一套断言，与数据库无关）：

```bash
JEFFLOW_DB=mysql node --import tsx --test __tests__/jdbc.test.ts
JEFFLOW_DB=postgres node --import tsx --test __tests__/jdbc.test.ts
```

建表 SQL 自动从本仓 `tests/schema/` 执行（IF NOT EXISTS，幂等；维护者改 jeeflow-java 仓 resources 后跑 `jeeflow-hub/scripts/sync-schema.sh` 同步）。已实测：mysql 3/3、postgres 3/3 全过。

---

## 管理扩展与统一门面（v1.1.0）

设计稿 / 历史 / 委托由扩展仓储 SPI 提供读写（文档站 spec §10），统一门面
`flow(action, map)` 按 action 路由（spec §11.2），返回 `{code, msg, data}`，
deploy 自动版本管理，execute 按 submitType 全分发，操作人由 `args.operator` 显式传入。

扩展仓储实现（JDBC + 内存）与门面均在本仓库：
- 扩展仓储：`<repository>/jdbc/ext.*`（JDBC）、memory 内存实现
- 门面：`facade.*` / `jeeflow/facade.py` / `src/facade.ts`

三张扩展表（wf_process_design / design_his / surrogate）SQL 已随 schema 分发
（`schema-<db>.sql`，维护源 jeeflow-java resources）。

> 分页说明（v1.1.0）：核心表分页 SPI（pageDefines/pageTodoTasks 等）目前 Java 提供，
> 本语言对应分页 action 返回明确错误，计划 1.2.0 补齐；设计/委托分页全支持。
