// audit8 R91（issues/234 §4.2）——节点级 pre/postInterceptors：节点声明优先、缺省回落流程根、
// 两档不叠加、声明未注册必须报错（条文＝spec02 §3「节点级拦截器的优先序、回落与键形」）。
// 反空转纪律：每档判据都先证明"拦截器真的被调到了"（calls 非空＋看到 apply 节点），再断形状。
import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { EngineImpl } from '../src/engine.js'
import { MemoryRepository } from '../src/memory.js'
import type { ProcessDefine } from '../src/model.js'
import { KeySubmitType } from '../src/engine.js'
import type { EngineExtensions } from '../src/extensions.js'

type Call = { phase: string; node: string }

function recorder(tag: string, sink: Call[]) {
  return {
    order: 0,
    async preHandle(node: any) { sink.push({ phase: `pre:${tag}`, node: node.id }); return true },
    async postHandle(node: any) { sink.push({ phase: `post:${tag}`, node: node.id }) },
  }
}

function defineWith(name: string, rootPost: string, rootPre: string, nodePost: string, nodePre: string): ProcessDefine {
  return {
    id: 0, name, displayName: name, type: 'approval', state: 1, version: 1,
    content: JSON.stringify({
      name, displayName: name, type: 'approval', relTableName: 'biz_r91', persistMode: 'SYNC',
      postInterceptors: rootPost, preInterceptors: rootPre,
      nodes: [
        { id: 'start', type: 'snaker:start', properties: {}, text: { value: '开始' } },
        {
          id: 'apply', type: 'snaker:task',
          properties: {
            assignee: 'user1',
            ...(nodePost ? { postInterceptors: nodePost } : {}),
            ...(nodePre ? { preInterceptors: nodePre } : {}),
          },
          text: { value: '申请' },
        },
        { id: 'finish', type: 'snaker:end', properties: {}, text: { value: '结束' } },
      ],
      edges: [
        { id: 'e0', sourceNodeId: 'start', targetNodeId: 'apply', properties: {} },
        { id: 'e1', sourceNodeId: 'apply', targetNodeId: 'finish', properties: {} },
      ],
    }),
    createTime: new Date(), updateTime: new Date(), createUser: '', updateUser: '',
  }
}

async function runFlow(engine: EngineImpl, repo: MemoryRepository, d: ProcessDefine, operator: string) {
  const inst = await engine.startProcessInstanceById(d.id, operator, { f_title: 'R91 单' })
  const todos = await repo.findDoingTasks(inst.id)
  assert.ok(todos.length >= 1, '前置：应有一条进行中任务（否则判据全部空转）')
  await engine.executeProcessTask(todos[0].id, operator, { [KeySubmitType]: 1 })
}

describe('R91 节点级拦截器优先序（issues/234 §4.2／spec02 §3）', () => {
  const mk = (ext: EngineExtensions) => {
    const repo = new MemoryRepository()
    const engine = new EngineImpl(repo, { async getUser(userId: string) { return { userId, realName: '用户' + userId, deptId: 'D01' } } } as any,
      { nextId() { return String(Date.now() + Math.random()) } }, { async eval() { return false } })
    engine.setExtensions(ext)
    return { repo, engine }
  }

  it('① 节点声明优先：节点与流程根同时声明 ⇒ 只跑节点声明那一条（两档不叠加）', async () => {
    const calls: Call[] = []
    const { repo, engine } = mk({ interceptors: [], interceptorRegistry: { node: recorder('node', calls), root: recorder('root', calls) } } as any)
    const d = defineWith('r91-priority', 'root', '', 'node', '')
    repo.addDefine(d)
    await runFlow(engine, repo, d, 'user1')
    // 优先序是**按节点**判的：apply 上只能看到节点声明那一条；finish 没声明 ⇒ 它回落根级是正确行为
    assert.ok(calls.some(c => c.phase === 'post:node' && c.node === 'apply'), `前置失效：节点级拦截器没被调到（calls=${JSON.stringify(calls)}）`)
    assert.ok(!calls.some(c => c.phase === 'post:root' && c.node === 'apply'), `apply 上节点声明与根声明叠加了：${JSON.stringify(calls)}`)
  })

  it('② 缺省回落流程根：节点不声明 ⇒ 走流程根那一档（回归既有形状）', async () => {
    const calls: Call[] = []
    const { repo, engine } = mk({ interceptors: [], interceptorRegistry: { root: recorder('root', calls) } } as any)
    const d = defineWith('r91-fallback-root', 'root', '', '', '')
    repo.addDefine(d)
    await runFlow(engine, repo, d, 'user1')
    assert.ok(calls.some(c => c.phase === 'post:root' && c.node === 'apply'), `节点不声明时没回落到流程根那一档：${JSON.stringify(calls)}`)
  })

  it('③ 根级 preInterceptors 也要读（修前零命中＝本栈旧形状只读根级 post）', async () => {
    const calls: Call[] = []
    const { repo, engine } = mk({ interceptors: [], interceptorRegistry: { rootpre: recorder('rootpre', calls) } } as any)
    const d = defineWith('r91-root-pre', '', 'rootpre', '', '')
    repo.addDefine(d)
    await runFlow(engine, repo, d, 'user1')
    // 本栈 pre 相位只在被推进的节点上触发（此处为 finish）⇒ 只断"根级 pre 被解析并执行"
    assert.ok(calls.some(c => c.phase === 'pre:rootpre'), `根级 preInterceptors 仍不被解析（修前即此形状）：${JSON.stringify(calls)}`)
  })

  it('④ 节点级 pre 也走同一优先序（节点声明 pre ⇒ 只跑它）', async () => {
    const calls: Call[] = []
    const { repo, engine } = mk({ interceptors: [], interceptorRegistry: { nodepre: recorder('nodepre', calls), rootpre: recorder('rootpre', calls) } } as any)
    // 本栈 pre 相位只在"被推进的节点"上触发（此流程里是 finish）⇒ 节点级声明挂到 finish 才不空转
    const d = defineWith('r91-node-pre', '', 'rootpre', '', '')
    const parsed = JSON.parse(d.content)
    parsed.nodes.find((n: any) => n.id === 'finish').properties.preInterceptors = 'nodepre'
    d.content = JSON.stringify(parsed)
    repo.addDefine(d)
    await runFlow(engine, repo, d, 'user1')
    assert.ok(calls.some(c => c.phase === 'pre:nodepre' && c.node === 'finish'), `节点级 pre 没触发：${JSON.stringify(calls)}`)
    assert.ok(!calls.some(c => c.phase === 'pre:rootpre' && c.node === 'finish'), `finish 上节点 pre 与根 pre 叠加了：${JSON.stringify(calls)}`)
  })

  it('⑤ 声明未注册 ⇒ 显式报错（节点档与根档同纪律，不静默忽略）', async () => {
    const { repo, engine } = mk({ interceptors: [], interceptorRegistry: {} } as any)
    const d = defineWith('r91-ghost', '', '', 'com.mldong.jeeflow.ghost.GhostInterceptor', '')
    repo.addDefine(d)
    await assert.rejects(
      () => runFlow(engine, repo, d, 'user1'),
      (e: any) => /未注册/.test(String(e?.message)) && /postInterceptors/.test(String(e?.message)),
    )
  })

  it('⑥ 缓存键含节点与档位：两节点声明不同拦截器 ⇒ 各自独立命中（防按 defineId 单键串档）', async () => {
    const calls: Call[] = []
    const { repo, engine } = mk({ interceptors: [], interceptorRegistry: { a: recorder('A', calls), b: recorder('B', calls) } } as any)
    const d: ProcessDefine = defineWith('r91-cache', '', '', 'a', '')
    const twoNodes = JSON.parse(d.content)
    twoNodes.nodes.push({ id: 'apply2', type: 'snaker:task', properties: { assignee: 'user1', postInterceptors: 'b' }, text: { value: '二级' } })
    twoNodes.edges.push({ id: 'e2', sourceNodeId: 'apply', targetNodeId: 'apply2', edgeType: 'approved', properties: {} })
    twoNodes.edges = twoNodes.edges.filter((e: any) => e.id !== 'e1')
    twoNodes.edges.push({ id: 'e3', sourceNodeId: 'apply2', targetNodeId: 'finish', properties: {} })
    d.content = JSON.stringify(twoNodes)
    repo.addDefine(d)
    const inst = await engine.startProcessInstanceById(d.id, 'user1', { f_title: '两节点' })
    let todos = await repo.findDoingTasks(inst.id)
    await engine.executeProcessTask(todos[0].id, 'user1', { [KeySubmitType]: 1 })
    todos = await repo.findDoingTasks(inst.id)
    assert.ok(todos.length >= 1, '前置失效：第二节点没建出来（缓存档判据会空转）')
    await engine.executeProcessTask(todos[0].id, 'user1', { [KeySubmitType]: 1 })
    assert.ok(calls.some(c => c.phase === 'post:A' && c.node === 'apply'), `第一节点未走 a：${JSON.stringify(calls)}`)
    assert.ok(calls.some(c => c.phase === 'post:B' && c.node === 'apply2'), `第二节点未走 b（缓存按 defineId 串档）：${JSON.stringify(calls)}`)
  })

  it('⑦ 根声明每定义只回查一行（拆节点档后不得把"读一次"放大成逐节点读）', async () => {
    // 直接量拦截器解析这一条腿（数 findDefineById 次数）：走整条流程量会被既有委托名缓存
    // （engine.ts 的 defineNameCache 按任务节点回查定义）混进来——那是 R91 之前就在的形状，
    // 拿它当判据会永红（实测 3 节点 5 次、摘掉根声明缓存也 5 次＝测不到自己要钉的东西）。
    const { repo, engine } = mk({ interceptors: [], interceptorRegistry: {} } as any)
    const d = defineWith('r91-reads', '', '', '', '')
    repo.addDefine(d)
    const inst = await engine.startProcessInstanceById(d.id, 'user1', { f_title: '读放大' })
    const nodeIds = (JSON.parse(d.content).nodes as any[]).map(n => n.id)
    assert.ok(nodeIds.length >= 3, `前置：节点数 ${nodeIds.length} 不足以照出放大`)
    let reads = 0
    const orig = repo.findDefineById.bind(repo)
    repo.findDefineById = async (id: any) => { reads++; return orig(id) }
    for (const nid of nodeIds) {
      for (const phase of ['pre', 'post'] as const) {
        await (engine as any).resolveInterceptors({ id: nid, properties: {} }, inst, phase)
      }
    }
    assert.ok(reads <= 1,
      `定义行被逐节点回查：${nodeIds.length} 节点 × 2 档 ⇒ ${reads} 次（根声明须每定义缓存一行）`)
  })
})
