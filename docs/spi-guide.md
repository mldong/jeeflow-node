# SPI 实现指南

> 引擎核心零依赖：仓储、用户、ID、表达式全部走 SPI（`src/spi.ts`）。接入自己的业务时实现这些接口，构造 `EngineImpl` 时注入。

## ProcessRepository（必须）

仓储是唯一必须实现的 SPI，映射 [规范 01 · 数据模型](../../spec/01-data-model) 的 5 张表（`wf_process_define/instance/task/task_actor/cc_instance`）：

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

## OrgUserProvider（可选，v1.6.0）

组织维度取人——内置组织 handler（部门领导/分管领导/角色）的数据源。
**业务方只实现数据接口，不写 handler**：

```ts
const orgProv: OrgUserProvider = {
  async findDeptLeaders(deptId: string) { return orgApi.leaderIds(deptId) },
  async findDeptMainLeaders(deptId: string) { return orgApi.mainLeaderIds(deptId) },
  async findByRole(roleCode: string) { return orgApi.userIdsByRole(roleCode) },
}
```

注册内置 handler（注册名与 Java 类全限定名一致，流程 JSON 四语言通用）：

```ts
import { HandlerRegistry, registerBuiltinAssignments } from '@mldong/jeeflow'

const registry = new HandlerRegistry()
registerBuiltinAssignments(registry, userProv, orgProv)   // 组织维度依赖注入
engine.setRegistry(registry)
```

> 内置 handler 的**场景/配置/注意事项**见 [用户指南 07 · 参与者解析](../../guides/07-assignment-handlers.md)。

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

### 委托代理运行期自动生效（issues/116，spec 05/06 定为 v1.9.0 起引擎内置）

`processSurrogate/*` 五个 action 只是**台账 CRUD**；真正的能力是**建单那一刻**由引擎对每个参与者
查一次生效委托，命中则把代理人**并入该任务的参与者集合**（随任务一起落 `wf_process_task_actor`，
授权人保留、任一可办——委托不是转办）。见 spec 06 §4.5 运行期语义。

装配链零配置即生效：`new JeeflowFacade(engine, repo, extRepo)` 会把 `extRepo` 注入引擎的委托查询面。

- **未配置扩展仓储 → 静默跳过**，不抛错、不打断建单（委托是增强能力，缺仓储属正常部署形态）
- **显式关闭**（任选一条，关闭后回到"仅台账"）：
  - `engine.setSurrogateEnabled(false)` —— 开关（默认为开）
  - `engine.setSurrogateRepository(null)` —— 摘掉查询源
  - `engine.setSurrogateRepository({ getSurrogate: async () => null })` —— 注册空实现
  - 构造参数形态：`new EngineImpl(repo, userProv, idGen, exprEval, { surrogateRepository: ext, surrogateEnabled: false })`
  - 只读自检：`engine.isSurrogateEnabled()`
- **查询判据（内存仓与 SQL 仓必须同结论）**：空 `processName` 全流程兜底（先精确后兜底）/
  时间窗 `start<=now<=end`（任一侧空 = 该侧不限）/ `surrogate <> operator` 自委托过滤 /
  `enabled` 只认 1（脏值不当启用，**门面写侧也把脏值归 0 落库**）
- **多条命中取主键 id 最大一条**（判据 1.4）：SQL 侧 `ORDER BY id DESC LIMIT 1`，内存侧显式比 id
  （雪花串按 BigInt 比数值），**不得按 Map 插入序取首条/末条**——乱序写入时两仓结论就分叉了
- **`processName` 取值口径**（判据 1.1）：以**流程模型 `name`**（流程 JSON）为准，模型未带时才回落
  `wf_process_define.name`。内置版（mldong-wf）的 `SurrogateInterceptor` 用的正是
  `execution.getProcessModel().getName()`，用户在内置版配的委托迁到 jeeflow 才命中得同一条
- **不级联**：只对建单那一刻的原始参与者快照逐个查一次，代理人自身的委托不展开（环状委托不死循环）

> 会签节点的成员列表（`operatorList_` / `nrOfInstances_`）**不含**代理人——委托只在该成员的任务上
> 追加参与人，不新增会签成员。委托在 todoList 的合并展示仍是集成方视图层职责（spec 05）。

> 分页说明（v1.1.0）：核心表分页 SPI（pageDefines/pageTodoTasks 等）目前 Java 提供，
> 本语言对应分页 action 返回明确错误，计划 1.2.0 补齐；设计/委托分页全支持。
