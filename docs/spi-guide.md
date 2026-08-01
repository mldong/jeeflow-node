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

> 开箱即用：`MemoryRepository`（`src/memory.ts`）供演示/测试；生产按上表映射到自己的数据库。

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
