# 快速开始（SDK 集成）

> 把 jeeflow-node 作为依赖集成到你的项目。演示站（Express 应用）见 [演示站（Demo）](./demo.md)。

## 安装

```bash
# ⚠️ 尚未发布到 npm——源码方式使用：
git clone https://github.com/mldong/jeeflow-node
# 你的项目里引用源码目录（或后续发布后 npm install @mldong/jeeflow）
```

引擎核心仅依赖 `node:*` 标准库（零外部依赖），需 Node 18+。

## 最小示例（内存模式，5 行跑起来）

不依赖任何数据库，适合学习、测试：

```ts
import { EngineImpl } from '@mldong/jeeflow/engine'
import { MemoryRepository } from '@mldong/jeeflow/memory'
import type { ProcessDefine } from '@mldong/jeeflow/model'

const repo = new MemoryRepository()
// 1. 注册流程定义（LogicFlow JSON，见流程定义格式）
repo.addDefine({
  id: 1, name: 'simple', displayName: '简单审批', type: 'approval', state: 1,
  content: JSON.stringify({ ...flowJson }),
  version: 1, createTime: new Date(), updateTime: new Date(), createUser: '', updateUser: '',
} as ProcessDefine)
// 2. 初始化引擎（仓储必传，其余 SPI 可选）
const engine = new EngineImpl(repo)
// 3. 启动流程（startAndExecute 契约：调用方自动完成申请节点）
const inst = await engine.startProcessInstanceById(1, 'user1', {})
for (const task of await repo.findDoingTasks(inst.id)) {
  await repo.addTaskActor(task.id, ['user1'])
  await engine.executeProcessTask(task.id, 'user1', { submitType: 0 })
}
console.log(inst.state)  // 10 进行中
```

## 下一步

- [引擎 API](./engine-api.md) —— `EngineImpl` 全部方法
- [流程定义格式](./flow-definition.md) —— LogicFlow JSON
- [SPI 实现指南](./spi-guide.md) —— 接入自己的数据库/用户体系
