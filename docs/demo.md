# Node.js 演示站（Demo）

> 演示站是运行在 :8082 的 Express 应用（内存仓储 + 14 个示例流程），对接 jeeflow-ui 体验完整流程。SDK 集成（SPI）见 [引擎 API](./engine-api.md) / [SPI 实现指南](./spi-guide.md)。

## 环境要求

- Node 18+
- 引擎核心仅依赖 `node:*` 标准库（零外部依赖）；演示站用 Express + tsx

## 启动演示站

```bash
npm install
npm run demo        # tsx 直接运行 demo/main.ts
# → http://localhost:8082
```

> 演示站从 `jeeflow-java` 的共享流程 JSON 加载 14 个示例流程。对接 jeeflow-ui（:5173）时右上角切到 `🟢 Node :8082`；接口规范见[统一门面接口文档](../../spec/06-facade)。

> v1.5.0 起 `/wf/**` 为**单入口门面转发**（`JeeflowFacade.flow(action, body)`，URL 路径段即 action）——
> 集成方 controller 一行转发即可复用全部流程能力，参数与返回结构不变。


## 快速验证

```bash
B=http://localhost:8082
curl -s -X POST $B/wf/processDefine/page -H "Content-Type: application/json" -d '{}'   # → {"code":0,"msg":"成功",...}
curl -s -X POST $B/wf/processDefine/startAndExecute -H "Content-Type: application/json" -d '{"processDefineId":9,"operator":"user1","amount":500}'
```

完整验证矩阵（同意/拒绝/退回发起人/highLight/approvalRecord）见文档站通用指南。

## 运行测试

```bash
npx tsc --noEmit      # 类型检查
npm test              # 引擎合规测试 10 项
```

## 生产部署

```bash
npx tsc
node dist/demo/main.js
```

生产接入：实现 `ProcessRepository` SPI（内存/DB 随意），映射 [规范 01 · 数据模型](../../spec/01-data-model) 的 5 张表。
