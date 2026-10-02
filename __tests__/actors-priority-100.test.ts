import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { EngineImpl } from '../src/engine.js'
import { MemoryRepository } from '../src/memory.js'
import { HandlerRegistry } from '../src/registry.js'
import type { ProcessDefine } from '../src/model.js'
import type { FlowNode, ProcessInstance } from '../src/model.js'

/**
 * 参与者解析优先级（issues/100 · Node 腿，与 Go 栈同批）。
 *
 * 基准＝java `CreateTaskHandler.resolveActors`（:84-141）三档顺序：
 *   1. `tf_nextNodeOperator`（非空即 return）
 *   2. `assignee`（token 命中变量则换值、`applicant` 换发起人）
 *   3. `assignmentHandler` —— **仅当上面两档没解析出人时**才生效（java 原话 `if (actors.isEmpty())`）
 *
 * 改前 `src/engine.ts` 的顺序是 handler(1a)→handler(1b)→动态指派→assignee，且 handler 命中即无条件
 * `return` ⇒ 节点同时配 `assignmentHandler` 与 `assignee`／`tf_nextNodeOperator` 时后两档被整档吞掉。
 * 八栈普查（10-02）：java／php／python／rust／csharp／moon 六栈都是 java 序，**只有 go 与 node 反着**。
 *
 * ⚠️ 为什么专门补这四格：`registerAssignment` 在本仓测试里改前从未与 assignee／动态指派同场出现过
 * ⇒ 这条优先级路径历史上零覆盖，顺序被改错不会有任何一格变红，这正是它能一直错着的原因。
 * 断言一律落在**读回的持久参与者**上（`findDoingTasks` → `task.actorIds`），不是引擎返回的聚合对象。
 */

function flowContent(name: string, taskProps: Record<string, any>): string {
  return JSON.stringify({
    name, displayName: '优先级 100 测试', type: 'test',
    nodes: [
      { id: 'start', type: 'snaker:start', properties: {}, text: { value: '开始' } },
      { id: 'task1', type: 'snaker:task', properties: { taskType: 0, performType: 0, ...taskProps }, text: { value: '审批' } },
      { id: 'end', type: 'snaker:end', properties: {}, text: { value: '结束' } },
    ],
    edges: [
      { id: 'e0', sourceNodeId: 'start', targetNodeId: 'task1', properties: {} },
      { id: 'e1', sourceNodeId: 'task1', targetNodeId: 'end', properties: {} },
    ],
  })
}

/** 引擎＋内存仓＋按名注册的指派处理器（恒定返回 ['zhang']）；define 由调用方给形状。 */
function harness(name: string, taskProps: Record<string, any>) {
  const mem = new MemoryRepository()
  const engine = new EngineImpl(mem)
  const registry = new HandlerRegistry()
  registry.registerAssignment('h100', {
    assign: (_node: FlowNode, _inst: ProcessInstance, _op: string) => ['zhang'],
  })
  engine.setRegistry(registry)
  const def = {
    id: '', name, displayName: '优先级 100 测试', type: 'test', state: 1,
    content: flowContent(name, taskProps), version: 1,
    createTime: new Date(), createUser: 't', updateTime: new Date(), updateUser: 't',
  } as ProcessDefine
  mem.addDefine(def)
  return { mem, engine, def }
}

/** 发起后 task1 那条 DOING 行的持久参与者。 */
async function actorsOf(name: string, taskProps: Record<string, any>, vars: Record<string, any> = {}) {
  const h = harness(name, taskProps)
  const inst = await h.engine.startProcessInstanceById(h.def.id, 'boss1', vars)
  const doing = await h.mem.findDoingTasks(inst.id)
  assert.equal(doing.length, 1, `夹具：应恰好一条 DOING 行，实得 ${doing.length}`)
  return [...doing[0].actorIds]
}

const BOTH = { assignee: 'carol', assignmentHandler: 'h100' }
const HANDLER_ONLY = { assignmentHandler: 'h100' }
const BLANK_ASSIGNEE = { assignee: ' , , ', assignmentHandler: 'h100' }

describe('issues/100 参与者解析优先级（node 腿 · 对齐 java 三档序）', () => {
  it('档 2 压档 3：同时配 assignee 与 assignmentHandler ⇒ 用 assignee 的人', async () => {
    assert.deepEqual(await actorsOf('i100-asn', BOTH), ['carol'],
      'java 序下 assignee 应压过 assignmentHandler（改前实得 ["zhang"]，carol 整档被吞）')
  })

  it('档 1 压档 3：带 tf_nextNodeOperator 时即使挂了 handler 也用它', async () => {
    assert.deepEqual(await actorsOf('i100-next', HANDLER_ONLY, { tf_nextNodeOperator: 'dave' }), ['dave'],
      'java 序下 tf_nextNodeOperator 应压过 assignmentHandler（改前实得 ["zhang"]）')
  })

  it('回归档：只挂 handler（无 assignee、无动态指派）⇒ handler 照常生效，重排不得把扩展点改没', async () => {
    assert.deepEqual(await actorsOf('i100-only', HANDLER_ONLY), ['zhang'],
      'handler 仍是"节点没配 assignee 时的扩展点"')
  })

  it('与 java `if (actors.isEmpty())` 逐字对齐：assignee 存在但解析为空 ⇒ 不算命中，回落 handler', async () => {
    assert.deepEqual(await actorsOf('i100-blank', BLANK_ASSIGNEE), ['zhang'],
      '全空白 assignee 不得算命中（拦"把 assignee 分支写成只要有键就 return"这种改一半）')
  })
})
