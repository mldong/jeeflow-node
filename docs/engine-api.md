# 引擎 API

> jeeflow-node 引擎对外接口（`src/engine.ts` 的 `EngineImpl`）。语义与 Java 参考实现一一对应，TypeScript 类型。

## 构造引擎

```ts
import { EngineImpl } from '@mldong/jeeflow/engine'
import { MemoryRepository } from '@mldong/jeeflow/memory'

const repo = new MemoryRepository()          // 内存仓储（演示/测试用）
const engine = new EngineImpl(repo, userProv?, idGen?, exprEval?)
//                                  ├── UserProvider（可选）
//                                  ├── IDGenerator（可选）
//                                  └── ExpressionEvaluator（可选，决策/会签表达式）
```

## 核心方法

```ts
interface Engine {
  startProcessInstanceById(defineId: number, operator: string, args?: Record<string, any>): Promise<ProcessInstance>
  executeProcessTask(taskId: number, operator: string, args?: Record<string, any>): Promise<ProcessInstance>
  executeAndJumpToEnd(taskId: number, operator: string, args?: Record<string, any>): Promise<ProcessInstance>          // 拒绝（REJECT=2）→ 实例 45
  executeAndJumpTask(taskId: number, operator: string, args: Record<string, any>, targetTaskName?: string): Promise<ProcessInstance>  // 跳转（JUMP=4）/退回上一步（ROLLBACK=3）
  executeAndJumpToFirstTaskNode(taskId: number, operator: string, args?: Record<string, any>): Promise<ProcessInstance> // 退回发起人（ROLLBACK_TO_OPERATOR=6）
}
```

```ts
// 启动并自动完成申请节点（startAndExecute 契约，调用方实现）
const inst = await engine.startProcessInstanceById(1, 'user1', { amount: 500 })
for (const task of await repo.findDoingTasks(inst.id)) {
  await repo.addTaskActor(task.id, [operator])
  await engine.executeProcessTask(task.id, 'user1', { submitType: 0 })  // APPLY
}
```

## 变量注入

引擎每次操作自动注入用户信息到流程变量：`u_userId` / `u_realName` / `u_deptId` / `u_deptName` / `u_postId` / `u_postName`（来自 `UserProvider`），key 与 mldong 框架一致。

## 状态码

- 实例：`10` 进行中 / `20` 已完成 / `45` 已拒绝（`InstanceState` 枚举）
- 任务：`10` 待办 / `20` 已完成 / `99` 已废弃（`TaskState` 枚举）

> submitType 全枚举行为见[设计原理 06](../../concepts/06-contracts)。
