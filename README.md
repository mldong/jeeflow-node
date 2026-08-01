# jeeflow · Node.js / TypeScript

[jeeflow](https://github.com/mldong/jeeflow-doc) 引擎规范的 **TypeScript 实现**。仅依赖 `node:*` 标准库，零外部依赖（引擎核心）。

```bash
npm install jeeflow   # 等发布到 npm 后
```

## 快速开始

```ts
import { EngineImpl, MemoryRepository } from 'jeeflow'

const repo = new MemoryRepository()
const engine = new EngineImpl(repo)

const def = {
  id: 1, name: 'leave', displayName: '请假审批',
  content: JSON.stringify({ nodes: [...], edges: [...] })
}
repo.addDefine(def)

const inst = await engine.startProcessInstanceById(def.id, '张三')
const tasks = await repo.findDoingTasks(inst.id)
await engine.executeProcessTask(tasks[0].id, 'leader')
```

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
| `src/jdbc.ts` | MySQL 参考实现（JdbcRepository，mysql2） |
| `demo/main.ts` | Express 演示 |
| `__tests__/` | 9 项合规测试 |

## 节点支持

对齐 [SPEC.md](https://github.com/mldong/jeeflow-doc) v1.0——与 Java/Go 版一致。

## License

Apache-2.0
