// audit8 R92（issues/230 拍 A）：node 执行族四法返回值对齐 spec04——**本次动作产出的任务行**。
// 基准＝java `JeeflowEngineImpl.executeProcessTask` 返回 `exec.getProcessTaskList()`
// （该清单只由 `Execution.addTask/addTasks` 喂＝建单/会签/回退复活行，历史行 `saveHistoryTasks` 那条腿
// 不进清单，见 Execution.java:34-36 的解耦注释），`exec == null` 时 `Collections.emptyList()`
// ⇒ 空档必须是**非 null 的空数组**（对外 `[]`），不是 `undefined`/`null`。
//
// 判据分档各打一件事，防"改了签名没人证明语义"与"拿现成查询糊过去"：
//   ① 串行链＝每一步返回行逐一对齐**该步新落的待办**（同 id、同实例、已在仓储）；
//   ② 扇出＝并行会签一次动作产 3 行必须**逐行**回传（摘掉任一追加腿在此红）；
//   ③ 反向哨兵＝会签中办掉一张、同节点另两张仍待办 ⇒ 本次产出 0 行、返回**必须为空**。
//      这一档专治"直接 return findDoingTasks"的假实现：那种写法 ①② 全绿而本档红；
//   ④ 终止＝末环办理使实例完成，返回空数组（非 undefined/null）且实例确为完成态；
//   ⑤ 回退复活档＝`executeAndJumpTask` 无目标名那半（血缘复活上一环）产出的行必须回传；
//   ⑥ 跳转档＝带目标名产出行回传、`executeAndJumpToEnd` 空数组、目标名不存在仍显性抛；
//   ⑦ 并发隔离＝同一 EngineImpl 两条实例并行办理，返回值不得互串
//      （作用域用 AsyncLocalStorage 而非 class 字段的理由，由本档而不是注释来钉）；
//   ⑧ 回归哨兵＝返回值与仓储里的同一行，建单没被写两遍；
//   ⑨ 串行会签＝首位建单腿与推进建单腿各有自己的追加点，各给一条判据（不靠 ② 的并行档代签）；
//   ⑩ 未知 countersignType 档＝仓库 16 份定义喂不到 default 支，就地合成一份钉住那条追加腿。
//
// 变异对照（六条追加腿逐条摘＋一条"假实现"）读数在 issues/230 §6／notes/R92.md：
// 六条腿各由 ①②⑤⑥⑨⑩ 中的对应档报红，"直接 return 当前待办"这种假实现只被 ③ 报红。
//
// 全档走内存仓，无真库腿 ⇒ 门票命令 `node --import tsx --test __tests__/*.test.ts` 自动收
// （`npm test` 只跑 spec.test.ts 一份，本文件不在其内）。
import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EngineImpl } from '../src/engine.js'
import { MemoryRepository } from '../src/memory.js'
import { InstanceState, type ProcessDefine, type ProcessTask } from '../src/model.js'
import { dir as flowsResolverDir } from '../flows-resolver.js'

function mkSeqIdGen() {
  const base = Date.now() * 1000
  let n = 0
  return { nextId() { n += 1; return String(base + n) } }
}

function setup() {
  const repo = new MemoryRepository()
  const userProv = {
    async getUser(userId: string) {
      return { userId, realName: '用户' + userId, deptId: 'D01', deptName: '测试部门', postId: 'P01', postName: '测试岗位' }
    },
  }
  const exprEval = { async eval() { return false } }
  return { engine: new EngineImpl(repo, userProv, mkSeqIdGen(), exprEval), repo }
}

function loadFlow(repo: MemoryRepository, filename: string): ProcessDefine {
  const content = readFileSync(flowsResolverDir() + '/' + filename, 'utf-8')
  const def: ProcessDefine = {
    id: 0, name: filename, displayName: filename, type: 'test', state: 1, content,
    version: 1, createTime: new Date(), updateTime: new Date(), createUser: '', updateUser: '',
  }
  repo.addDefine(def)
  return def
}

const doingOf = (repo: MemoryRepository, instanceId: string) => repo.findDoingTasks(instanceId)

/** 补齐参与者后办理（与既有夹具同法），返回执行族的返回值 */
async function act(engine: EngineImpl, repo: MemoryRepository, taskId: string, operator: string, args: Record<string, any> = {}) {
  await repo.addTaskActor(taskId, [operator])
  const t = await repo.findTaskById(taskId)
  if (t && !t.actorIds.includes(operator)) {
    t.actorIds.push(operator)
    await repo.saveTask(t)
  }
  return engine.executeProcessTask(taskId, operator, args)
}

/** 返回行的三条硬形状：是数组、id 集合等于期望、逐行已落库且属本实例 */
async function assertRows(repo: MemoryRepository, instanceId: string, rows: any[], wantIds: string[], tag: string) {
  assert.ok(Array.isArray(rows), `${tag}：返回值必须是数组（java emptyList 同档，不得 undefined/null）`)
  const got = rows.map(r => String(r.id)).sort()
  assert.deepEqual(got, [...wantIds].sort(), `${tag}：返回行 id 集合应等于本次动作产出的集合`)
  for (const r of rows) {
    assert.equal(String(r.processInstanceId), instanceId, `${tag}：返回行 ${r.id} 的实例号应等于 ${instanceId}`)
    assert.ok(await repo.findTaskById(String(r.id)), `${tag}：返回行必须已在仓储里（id=${r.id}）`)
  }
}

describe('R92 执行族回传「本次动作产出的任务行」（node 半边）', () => {

  it('① 串行链：每一步返回行＝该步新建的待办行', async () => {
    const { engine, repo } = setup()
    const def = loadFlow(repo, '02-multi-task.json')
    let inst = await engine.startProcessInstanceById(def.id, 'alice', {})
    const steps = [['apply', 'alice'], ['task1', 'leader'], ['task2', 'manager'], ['task3', 'boss']]
    for (const [taskName, operator] of steps) {
      const cur = (await doingOf(repo, inst.id)).find(t => t.taskName === taskName)
      assert.ok(cur, `前置：应有 ${taskName} 待办，实得 ${(await doingOf(repo, inst.id)).map(t => t.taskName).join(',')}`)
      const rows = await act(engine, repo, cur.id, operator)
      const after = await doingOf(repo, inst.id)
      await assertRows(repo, String(inst.id), rows, after.map(t => String(t.id)), `${taskName}→`)
      inst = (await repo.findInstanceById(inst.id))!
    }
    assert.equal(inst.state, InstanceState.Done, '02-multi-task 四步办完实例应完成')
  })

  it('② 扇出：并行会签一次动作产三行必须逐行回传', async () => {
    const { engine, repo } = setup()
    const def = loadFlow(repo, '05-countersign-parallel.json')
    const inst = await engine.startProcessInstanceById(def.id, 'alice', {})
    const apply = (await doingOf(repo, inst.id)).find(t => t.taskName === 'apply')!
    const rows = await act(engine, repo, apply.id, 'alice')
    assert.equal(rows.length, 3, `会签建单应回传 3 行，实得 ${rows.length} 行`)
    assert.deepEqual(rows.map(r => r.taskName), ['task1', 'task1', 'task1'], '回传的行都应是会签节点的 task1')
    await assertRows(repo, String(inst.id), rows, (await doingOf(repo, inst.id)).map(t => String(t.id)), '会签扇出')
  })

  it('③ 反向哨兵：同节点仍有余单但本次零产出 ⇒ 返回空数组', async () => {
    const { engine, repo } = setup()
    const def = loadFlow(repo, '05-countersign-parallel.json')
    const inst = await engine.startProcessInstanceById(def.id, 'alice', {})
    const apply = (await doingOf(repo, inst.id)).find(t => t.taskName === 'apply')!
    await act(engine, repo, apply.id, 'alice')
    // 办掉 userA 那一张：另两张仍是待办，但**不是本次动作产出的**
    // （会签行的 actorId 是空的，参与人在 actorIds 里 ⇒ 按 actorIds 认领，与门面认领口径同形）
    const first = (await doingOf(repo, inst.id)).find(t => t.actorIds.includes('userA'))!
    assert.ok(first, '前置：会签应有一条参与者为 userA 的待办')
    const rows = await engine.executeProcessTask(first.id, 'userA', {})
    assert.equal((await doingOf(repo, inst.id)).length, 2, '前置：会签办掉一张应还剩两张待办')
    assert.ok(Array.isArray(rows) && rows.length === 0,
      `本次动作没有新建任务，返回应是空数组，实得 ${JSON.stringify(rows?.map?.(r => r.taskName) ?? rows)}` +
      `（若实现直接 return findDoingTasks 会在此红＝把"仍待办的他人单"当"本次产出"）`)
  })

  it('④ 终止档：末环返回空数组而不是 undefined/null，实例完成', async () => {
    const { engine, repo } = setup()
    const def = loadFlow(repo, '01-simple.json')
    let inst = await engine.startProcessInstanceById(def.id, 'alice', {})
    const apply = (await doingOf(repo, inst.id)).find(t => t.taskName === 'apply')!
    const rows1 = await act(engine, repo, apply.id, 'alice')
    assert.equal(rows1.length, 1, '前置：办理 apply 应产出一行')
    inst = (await repo.findInstanceById(inst.id))!
    assert.notEqual(inst.state, InstanceState.Done, '前置：办末环前实例不应已完成')
    const last = (await doingOf(repo, inst.id))[0]
    const rows = await act(engine, repo, last.id, 'leader')
    assert.ok(Array.isArray(rows), '末环返回值必须是数组（不得 undefined/null）')
    assert.equal(rows.length, 0, `实例已到 end 不应有产出行，实得 ${rows.length}`)
    inst = (await repo.findInstanceById(inst.id))!
    assert.equal(inst.state, InstanceState.Done, '末环办完实例应完成')
  })

  it('⑤ 回退复活档：血缘复活的那一行必须回传', async () => {
    const { engine, repo } = setup()
    const def = loadFlow(repo, '02-multi-task.json')
    const inst = await engine.startProcessInstanceById(def.id, 'alice', {})
    const apply = (await doingOf(repo, inst.id)).find(t => t.taskName === 'apply')!
    await act(engine, repo, apply.id, 'alice')
    const task1 = (await doingOf(repo, inst.id)).find(t => t.taskName === 'task1')!
    await repo.addTaskActor(task1.id, ['leader'])
    const rows = await engine.executeAndJumpTask(task1.id, 'leader', {})
    await assertRows(repo, String(inst.id), rows, (await doingOf(repo, inst.id)).map(t => String(t.id)), '回退复活')
    assert.deepEqual(rows.map(r => r.taskName), ['apply'], `应复活上一环 apply，实得 ${JSON.stringify(rows.map(r => r.taskName))}`)
  })

  it('⑥ 跳转档：带目标名回传产出行／跳到结束回空数组／目标名不存在仍显性抛', async () => {
    // a) 跳到 task3 ⇒ 产出一行 task3
    {
      const { engine, repo } = setup()
      const def = loadFlow(repo, '02-multi-task.json')
      const inst = await engine.startProcessInstanceById(def.id, 'alice', {})
      const apply = (await doingOf(repo, inst.id)).find(t => t.taskName === 'apply')!
      await repo.addTaskActor(apply.id, ['alice'])
      const rows = await engine.executeAndJumpTask(apply.id, 'alice', {}, 'task3')
      await assertRows(repo, String(inst.id), rows, (await doingOf(repo, inst.id)).map(t => String(t.id)), '跳转 task3')
      assert.deepEqual(rows.map(r => r.taskName), ['task3'], `跳转应产出 task3，实得 ${JSON.stringify(rows.map(r => r.taskName))}`)
    }
    // b) 直接结束 ⇒ 不建单 ⇒ 空数组
    {
      const { engine, repo } = setup()
      const def = loadFlow(repo, '02-multi-task.json')
      const inst = await engine.startProcessInstanceById(def.id, 'alice', {})
      const apply = (await doingOf(repo, inst.id)).find(t => t.taskName === 'apply')!
      await repo.addTaskActor(apply.id, ['alice'])
      const rows = await engine.executeAndJumpToEnd(apply.id, 'alice', {})
      assert.ok(Array.isArray(rows), 'executeAndJumpToEnd 返回值必须是数组')
      assert.equal(rows.length, 0, `跳结束不建单，返回应是空数组，实得 ${rows.length}`)
      assert.equal((await doingOf(repo, inst.id)).length, 0, '跳结束后不应有待办')
    }
    // c) 目标名不存在 ⇒ 显性抛（签名变化不该吞掉这条既有义务）
    {
      const { engine, repo } = setup()
      const def = loadFlow(repo, '02-multi-task.json')
      const inst = await engine.startProcessInstanceById(def.id, 'alice', {})
      const apply = (await doingOf(repo, inst.id)).find(t => t.taskName === 'apply')!
      await repo.addTaskActor(apply.id, ['alice'])
      await assert.rejects(() => engine.executeAndJumpTask(apply.id, 'alice', {}, 'nope'),
        /根据节点名称\[nope\]无法找到节点模型/)
    }
    // d) 跳回首任务节点 ⇒ 产出一行（链＝apply→task1→task2→task3，先办两步站到 task2）
    {
      const { engine, repo } = setup()
      const def = loadFlow(repo, '02-multi-task.json')
      const inst = await engine.startProcessInstanceById(def.id, 'alice', {})
      const apply = (await doingOf(repo, inst.id)).find(t => t.taskName === 'apply')!
      await act(engine, repo, apply.id, 'alice')
      const task1 = (await doingOf(repo, inst.id)).find(t => t.taskName === 'task1')!
      await act(engine, repo, task1.id, 'leader')
      const task2 = (await doingOf(repo, inst.id)).find(t => t.taskName === 'task2')
      assert.ok(task2, `前置：办完 apply/task1 后应站到 task2（实得 ${(await doingOf(repo, inst.id)).map(t => t.taskName).join(',')}）`)
      await repo.addTaskActor(task2.id, ['alice'])
      const rows = await engine.executeAndJumpToFirstTaskNode(task2.id, 'alice', {})
      assert.ok(Array.isArray(rows), 'executeAndJumpToFirstTaskNode 返回值必须是数组')
      await assertRows(repo, String(inst.id), rows, (await doingOf(repo, inst.id)).map(t => String(t.id)), '跳首任务节点')
      assert.equal(rows.length, 1, `跳回首任务节点应产出一行，实得 ${rows.length}`)
      assert.equal(rows[0].taskName, 'apply', `首任务节点＝apply，实得 ${rows[0].taskName}`)
      assert.ok(rows[0].actorId === 'alice' || rows[0].actorIds.includes('alice'),
        `跳首任务节点时 assignee 强制为发起人（对齐 java isFirstTaskName 那半），实得 actorId=${rows[0].actorId} actorIds=${rows[0].actorIds}`)
    }
  })

  it('⑦ 并发隔离：同一引擎两条实例并行办理，返回值不得互串', async () => {
    const { engine, repo } = setup()
    const def = loadFlow(repo, '02-multi-task.json')
    const i1 = await engine.startProcessInstanceById(def.id, 'alice', {})
    const i2 = await engine.startProcessInstanceById(def.id, 'bob', {})
    const a1 = (await doingOf(repo, i1.id)).find(t => t.taskName === 'apply')!
    const a2 = (await doingOf(repo, i2.id)).find(t => t.taskName === 'apply')!
    await repo.addTaskActor(a1.id, ['alice'])
    await repo.addTaskActor(a2.id, ['bob'])
    const [r1, r2] = await Promise.all([
      engine.executeProcessTask(a1.id, 'alice', {}),
      engine.executeProcessTask(a2.id, 'bob', {}),
    ])
    assert.equal(r1.length, 1, `实例一本次应只回传一行，实得 ${r1.length}`)
    assert.equal(r2.length, 1, `实例二本次应只回传一行，实得 ${r2.length}`)
    assert.equal(String(r1[0].processInstanceId), String(i1.id), '实例一的返回行必须属实例一')
    assert.equal(String(r2[0].processInstanceId), String(i2.id), '实例二的返回行必须属实例二')
  })

  it('⑧ 门面腿回归哨兵：签名改动不动 HTTP 出口形状', async () => {
    const { engine, repo } = setup()
    const def = loadFlow(repo, '01-simple.json')
    const inst = await engine.startProcessInstanceById(def.id, 'alice', {})
    const apply = (await doingOf(repo, inst.id)).find(t => t.taskName === 'apply')!
    const rows = await act(engine, repo, apply.id, 'alice')
    const doing = await doingOf(repo, inst.id)
    assert.equal(doing.length, 1, '动作后待办仍是一行（返回值来自同一批建行，不重复写入）')
    assert.equal(doing[0].id, rows[0].id)
    const t: ProcessTask = doing[0]
    assert.equal(t.taskName, 'task1')
  })

  // 串行会签的两条建单腿各有自己的追加点（首位成员建行 / 办完一位推进下一位建行），
  // 摘掉任意一条都只在这一档现形 ⇒ 必须各给一条判据，不能靠 ② 的并行档代签。
  it('⑨ 串行会签：首位建单腿与推进建单腿各自回传', async () => {
    const { engine, repo } = setup()
    const def = loadFlow(repo, '06-countersign-sequential.json')
    const inst = await engine.startProcessInstanceById(def.id, 'alice', {})
    const apply = (await doingOf(repo, inst.id)).find(t => t.taskName === 'apply')!
    // a) 办理 apply ⇒ 串行会签只建**首位**成员那一行
    const first = await act(engine, repo, apply.id, 'alice')
    assert.equal(first.length, 1, `串行会签首位应只建一行，实得 ${first.length}`)
    assert.equal(first[0].taskName, 'task1')
    assertRows(repo, String(inst.id), first, (await doingOf(repo, inst.id)).map(t => String(t.id)), '串行首位')
    // b) 办完首位 ⇒ 推进建出第二位成员那一行（摘掉推进腿 ⇒ 这里红）
    const second = await act(engine, repo, first[0].id, 'userA')
    assert.equal(second.length, 1, `串行推进应回传下一位成员一行，实得 ${second.length}`)
    assert.equal(second[0].taskName, 'task1', '推进出的仍是会签节点的行')
    assertRows(repo, String(inst.id), second, (await doingOf(repo, inst.id)).map(t => String(t.id)), '串行推进')
  })

  // 未配/未知 countersignType 那一档（default 支＝全员预创建）：仓库里 16 份流程定义没有一份喂得到它
  // （06/08 是 SEQUENTIAL、05/07/13 是 PARALLEL），⇒ 就地合成，别让这条追加腿挂空。
  it('⑩ 未知会签类型档：全员预创建的多行必须逐行回传（合成分支）', async () => {
    const { engine, repo } = setup()
    const raw = JSON.parse(readFileSync(flowsResolverDir() + '/06-countersign-sequential.json', 'utf-8'))
    for (const n of raw.nodes) {
      if (n.properties?.countersignType === 'SEQUENTIAL') n.properties.countersignType = 'RATIO'
    }
    const def: ProcessDefine = {
      id: 0, name: 'i230-cs-unknown', displayName: 'i230 未知会签类型', type: 'test', state: 1,
      content: JSON.stringify(raw), version: 1, createTime: new Date(), updateTime: new Date(),
      createUser: '', updateUser: '',
    }
    repo.addDefine(def)
    const inst = await engine.startProcessInstanceById(def.id, 'alice', {})
    const apply = (await doingOf(repo, inst.id)).find(t => t.taskName === 'apply')!
    const rows = await act(engine, repo, apply.id, 'alice')
    assert.equal(rows.length, 2, `未知会签类型＝全员预创建，userA/userB 两行都要回传，实得 ${rows.length}`)
    assertRows(repo, String(inst.id), rows, (await doingOf(repo, inst.id)).map(t => String(t.id)), '未知会签档')
  })
})
