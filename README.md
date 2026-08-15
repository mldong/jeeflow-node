# jeeflow · Node.js / TypeScript

[jeeflow](https://jeeflow-doc.mldong.com) 引擎规范的 **TypeScript 实现**。仅依赖 `node:*` 标准库，零外部依赖（引擎核心）。

> **v1.1.0**：新增管理扩展（流程设计/历史/委托 + `ProcessExtRepository`）与统一门面
> `JeeflowFacade.flow(action, args)`；assignee 变量解析与 `flow.auto`/`flow.admin` 系统代执行对齐 boot2/boot3。

```bash
npm install @mldong/jeeflow   # 等发布到 npm 后
```

## 快速开始

```ts
import { EngineImpl, MemoryRepository } from '@mldong/jeeflow'

const repo = new MemoryRepository()
const engine = new EngineImpl(repo)

const def = {
  id: '1', name: 'leave', displayName: '请假审批',
  content: JSON.stringify({ nodes: [...], edges: [...] })
}
repo.addDefine(def)

const inst = await engine.startProcessInstanceById(def.id, '张三')
const tasks = await repo.findDoingTasks(inst.id)
await engine.executeProcessTask(tasks[0].id, 'leader')
```

> ⚠️ **id 全程 string（issue 38 E9）**：引擎内部与 API 契约的 id（流程定义/实例/任务/设计）一律为**字符串**。
> Java 雪花 id（>2^53）超出 JS 安全整数，`Number()` 转换必丢精度；字符串可无损承载，保证四语言同库共享流程。

## JDBC（MySQL/PostgreSQL）

```ts
import mysql from 'mysql2/promise'
import { JdbcRepository, TsIDGenerator, MysqlAdapter } from '@mldong/jeeflow/jdbc'

// ⚠️ 必须配置 bigNumberStrings（issue 38 E9）：BIGINT 列以 string 返回，
// 否则 mysql2 默认转 number，Java 雪花 id（>2^53）在驱动层就已丢精度
const pool = mysql.createPool({
  host: 'localhost', user: 'root', password: '***', database: 'wf',
  supportBigNumbers: true,
  bigNumberStrings: true,
})
const repo = new JdbcRepository(new MysqlAdapter(pool), new TsIDGenerator())
```

- MySQL 连接池必须带 `supportBigNumbers: true, bigNumberStrings: true`；PostgreSQL 的 int8 默认即字符串，无此要求
- 引擎侧已做驱动兜底：`rowId()` 把驱动返回的 number/string 统一归一化为 string，未开 `bigNumberStrings` 时小 id（Node 自建）仍可用
- `MysqlAdapter` 走 `query()` 不走 `execute()`：mysql2 预处理绑 `LIMIT ?` 会失败，分页整段 99999999（issues/66）

## 运行演示

```bash
git clone https://github.com/mldong/jeeflow-node
cd jeeflow-node
npm install
npm run demo     # http://localhost:8082
```

## 目录

| 路径 | 说明 |
|------|------|
| `src/engine.ts` | 引擎核心 |
| `src/model.ts` | 域类型 |
| `src/spi.ts` | SPI 接口 |
| `src/memory.ts` | 内存仓储 |
| `src/jdbc/` | JDBC 多库实现（shared 核心 + mysql/postgres 适配器） |
| `demo/main.ts` | Express 演示 |
| `__tests__/` | 9 项合规测试 |

## 节点支持

对齐 [SPEC.md](https://jeeflow-doc.mldong.com) v1.0——与 Java/Go 版一致。

## License

Apache-2.0
