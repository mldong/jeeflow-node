# Express 集成

`jeeflow-node` 内置 Express 演示模块（`demo/main.ts`），可作为集成参考：路由、CORS、中间件的完整范例。

## 最小集成

```ts
import express from 'express'
import { EngineImpl } from '@mldong/jeeflow/engine'
import { MemoryRepository } from '@mldong/jeeflow/memory'

const app = express()
app.use(express.json())
// CORS——允许前端跨域直连（生产改为指定域名）
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS, PUT, DELETE')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (_req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

const repo = new MemoryRepository()   // 生产替换为你的仓储实现（见 SPI 指南）
const engine = new EngineImpl(repo, userProv, idGen, exprEval)
```

## REST 端点

demo 提供了完整的 mldong 框架兼容端点（`/wf/processDefine/*`、`/wf/processInstance/*`、`/wf/processTask/*`、`/api/stats`），直接复制或按需裁剪：

```ts
app.post('/wf/processDefine/startAndExecute', async (req, res) => {
  const { processDefineId, operator } = req.body
  const inst = await engine.startProcessInstanceById(Number(processDefineId), operator, req.body)
  // startAndExecute 契约：自动完成申请节点
  for (const task of await repo.findDoingTasks(inst.id)) {
    await repo.addTaskActor(task.id, [operator])
    await engine.executeProcessTask(task.id, operator, { submitType: 0 })
  }
  res.json({ code: 0, msg: '成功', data: null })
})
```

端点清单与响应结构（code=0/msg、submitType 全枚举）见[统一门面接口文档](../../spec/06-facade)。

## 启动

```bash
npm run demo       # 开发（tsx 直跑）
npx tsc && node dist/demo/main.js   # 生产
```

> 完整示例：`demo/main.ts`（含 CORS、VO 转换、submitType 全枚举 switch、highLight/approvalRecord 独立端点）。
