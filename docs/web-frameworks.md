# Node.js · Web 框架接入（统一门面转发层）

> 目标：**任意 Node.js Web 框架都能在 10 分钟内接入统一门面（JeeflowFacade）**——
> 门面接入 = **1 个路由 + 3 个注入点**，框架差异只在这 ~20 行转发层代码里。
> 引擎初始化、SPI、id 契约都是框架无关的（见 [SDK 集成](./getting-started.md) 与
> [规范 06 统一门面](../../spec/06-facade)）。

## 1. 门面接入模式（四步总则）

```
框架层                                 jeeflow 引擎层
┌───────────────────────────┐         ┌──────────────────────┐
│ POST /wf/{action} 路由      │  body   │ JeeflowFacade         │
│ ① 登录校验（框架已有）       │ ──────→ │  flow(action, args)   │
│ ② 权限码动态校验             │  args   │  40 个 action 内置路由  │
│ ③ operator 注入             │         └──────────────────────┘
│ ④ listByType 结构转换（可选）│
└───────────────────────────┘
```

| # | 步骤 | 说明 |
|---|------|------|
| 1 | 路由捕获 action | `POST /wf/{action}`，action 是多段路径（`processDefine/page`） |
| 2 | 登录校验 | 用框架已有的登录中间件/守卫（门面不感知登录态） |
| 3 | 权限码校验 | 引擎 SPI 提供映射（默认 `wf:{action.replace('/',':')}`），superAdmin 放行（见 [规范 06 §2.6](../../spec/06-facade)） |
| 4 | operator 注入 | `args.operator = 当前登录用户 id`——"我的"语义 action 依赖它过滤 |

> **id 字符串契约**：Node 引擎全链路 string，天然满足，前端无需额外处理。
> **listByType 转换**：`processDesign/listByType` 引擎返回 `Map<type, items>`；若前端按
> boot3 惯例期望 `[{type, title, items}]`，转发层做一次转换（见各框架示例）。

## 2. Express

```typescript
import express from 'express';

const app = express();
app.use(express.json());

// Express 4：/wf/*action 捕获多段路径（含 /）
app.post('/wf/*action', async (req, res) => {
  const action = req.params.action;             // 'processDefine/page'
  // ① 登录校验（框架已有中间件，req.user 由认证中间件注入）
  const user = req.user;
  if (!user) return res.status(401).json({ code: 99990403, msg: '未登录' });
  // ② 权限码动态校验（superAdmin 万能放行）
  const codes = permissionCodes(action);
  if (!user.superAdmin && codes && !codes.some((c) => user.permissions.includes(c))) {
    return res.status(403).json({ code: 99990406, msg: '无权限' });
  }
  // ③ 注入操作人
  const args = { ...(req.body ?? {}) };
  args.operator = user.id;
  // ④ 门面转发
  const result = await facade.flow(action, args);
  // ⑤ listByType 转换（按需）
  if (action === 'processDesign/listByType' && result?.code === 0) {
    result.data = Object.entries(result.data ?? {}).map(([type, items]) => ({ type, title: '', items }));
  }
  res.json(result);
});
```

## 3. NestJS（参考实现）

```typescript
import { Body, Controller, Param, Post } from '@nestjs/common';

@Controller()
export class WfController {
  constructor(private readonly wfService: WfJeeflowService) {}

  // Express 5（path-to-regexp v8）命名通配符：wf/*splat 匹配 wf/{action 多段}，
  // 捕获值中多段分隔符是 `,`（v8 行为）——必须还原为 `/`
  @Post('wf/*splat')
  async flow(@Param('splat') splat: string, @Body() body: Record<string, any>) {
    const action = splat.replace(/,/g, '/');     // 'processDesign,listByType' → 'processDesign/listByType'
    const user = LoginUserHolder.getCurrentUser();
    if (!user) throw new UnauthorizedException('token不存在或无效！');
    // ② 权限码动态校验（superAdmin 万能放行）
    if (!user.superAdmin) {
      const codes = permissionCodes(action);
      if (codes && !codes.some((c) => user.permissions.includes(c))) {
        throw new ForbiddenException(`您没有资源wf:${action}访问权限，请联系管理员！`);
      }
    }
    // ③ 注入操作人
    const args = { ...(body ?? {}) };
    args.operator = user.id;
    // ④ 门面转发
    const result = await this.wfService.flow(action, args);
    // ⑤ listByType 转换
    if (action === 'processDesign/listByType' && result?.code === 0) {
      result.data = Object.entries(result.data ?? {}).map(([type, items]) => ({ type, title: '', items }));
    }
    return result;
  }
}
```

> **坑（必踩）**：Express 5 的 `*splat` 通配符把多段路径捕获成**逗号分隔**，
> 必须 `splat.replace(/,/g, '/')` 还原。完整参考实现：mldong-nestjs 集成仓
> `src/modules/wf/controller/wf.controller.ts`。

## 4. Fastify

```typescript
import Fastify from 'fastify';

const fastify = Fastify();

// Fastify 通配符 * 捕获多段路径（含 /），req.params['*'] 为完整后缀
fastify.post('/wf/*', async (req, reply) => {
  const action = (req.params as any)['*'];      // 'processDefine/page'
  // ① 登录校验（插件注入：req.user）
  const user = (req as any).user;
  if (!user) return reply.code(401).send({ code: 99990403, msg: '未登录' });
  // ② 权限码动态校验（superAdmin 万能放行）
  const codes = permissionCodes(action);
  if (!user.superAdmin && codes && !codes.some((c) => user.permissions.includes(c))) {
    return reply.code(403).send({ code: 99990406, msg: '无权限' });
  }
  // ③ 注入操作人
  const args = { ...((req.body as any) ?? {}) };
  args.operator = user.id;
  // ④ 门面转发
  const result = await facade.flow(action, args);
  // ⑤ listByType 转换（同前）
  return reply.send(result);
});
```

> **注意**：Fastify 路由注册 `{ action: ... }` 在 v4+ 走 JSON Schema 校验，转发层
> 建议用 `schema: { hide: true }` 或宽松 body 约束，避免 schema 校验拦截未知表单字段。

## 5. 差异点对照表

| 要点 | Express | NestJS | Fastify |
|------|---------|--------|---------|
| 多段路径捕获 | `*action`（req.params.action） | `*splat`（**逗号分隔，需还原 `/`**） | `*`（req.params['*']） |
| 登录上下文 | req.user（中间件注入） | LoginUserHolder（守卫注入） | req.user（插件注入） |
| 权限校验 | 中间件内手动 | 守卫/管道 | 插件/手动 |
| 参考实现 | — | mldong-nestjs 集成仓 | — |

> 其他框架（Koa/Fastify/Hono…）同理：套「1 路由 + 3 注入点」模式即可。
> 引擎初始化（仓储/SPI/用户体系映射）见 [SDK 集成](./getting-started.md) 与 [SPI 实现指南](./spi-guide.md)。
