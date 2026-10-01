import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EngineImpl } from '../src/engine.js'
import { MemoryRepository } from '../src/memory.js'
import { MemoryExtRepository } from '../src/memory-ext.js'
import { JeeflowFacade } from '../src/facade.js'
import { SubmitType, TaskState } from '../src/model.js'
import type { ExpressionEvaluator, UserProvider } from '../src/spi.js'
import type { ProcessEvent } from '../src/extensions.js'
import { dir as flowsResolverDir } from '../flows-resolver.js'

/**
 * 门面第 **47** 个 action `processTask/removeTaskActor`（issues/115 残留 · Node 腿，八栈同批）。
 * 逐字判据依据＝spec 06-facade.md **§processTask/removeTaskActor**（七条语义＋守卫次序）与 §2.11
 * （归属值归一单点）。Java 基准腿＝`RemoveTaskActorActionTest`（17 格），本文件按同等判据复刻。
 *
 * 三个兄弟 action 的分工是判据主线：`surrogate`/`addCandidate` 只加、`transfer` 换人＋留痕、
 * 本 action **只摘不加零留痕**（不写变量、不覆写任务 actorId/operator 列、**不 fire 事件**——
 * issues/132 §11.3 定稿事件集没有"摘人"码）。每条负向都同时断言"参与者一动不动"：
 * 摘人是删除操作，报错却删了一半比报错更糟。
 *
 * `DirtyRowSpyRepo` 对应门禁新格「带空格入参删得掉真人 ∧ 空值不误删 actor_id='' 脏行 ∧
 * 喂进仓储的实参是行上的原值」：内存仓写侧归一（`writeActors` → `normalizeActors`）后正常路径
 * **建不出**空串行，故脏行只能从外部塞进来；spy 同时复刻 `DELETE ... WHERE actor_id IN (...)`
 * 的逐字语义（按实参**原值**精确命中、绝不 trim 再比）并记录每次喂进 DELETE 的实参。
 */

// id 发生器必须是单调计数器（同 spec.test.ts 的 mkSeqIdGen 理由：Date.now()+随机数同毫秒撞号率
// 实测 54%，撞上的 id 在内存仓 Map 里互相覆盖 ⇒ 随机复现的假红）。
function mkSeqIdGen() {
  const base = Date.now() * 1000
  let n = 0
  return { nextId() { n += 1; return String(base + n) } }
}
const flowDir = flowsResolverDir() + '/'

/** 参与者 spy 仓储：见文件头说明（脏行塞得进、DELETE 实参看得见、删除按列值精确命中）。 */
class DirtyRowSpyRepo extends MemoryRepository {
  private dirty = new Map<string, string[]>()
  readonly removeCalls: string[][] = []

  seedDirtyRow(taskId: string, actorId: string): void {
    const rows = this.dirty.get(taskId) ?? []
    rows.push(actorId)
    this.dirty.set(taskId, rows)
  }

  dirtyRemaining(taskId: string): string[] {
    return [...(this.dirty.get(taskId) ?? [])]
  }

  /** 只取"真人"那一半（脏行与真行分开取证，判据才指得准是谁被删了） */
  async findRealActors(taskId: string): Promise<string[]> {
    return [...await super.findTaskActors(taskId)]
  }

  async findTaskActors(taskId: string): Promise<string[]> {
    // 与 JDBC 一条裸 SELECT 同形：脏行本来就会被读出来
    return [...await super.findTaskActors(taskId), ...(this.dirty.get(taskId) ?? [])]
  }

  async removeTaskActor(taskId: string, actors: string[]): Promise<void> {
    this.removeCalls.push([...actors])
    const rows = this.dirty.get(taskId)
    if (rows) this.dirty.set(taskId, rows.filter(r => !actors.includes(r)))
    await super.removeTaskActor(taskId, actors)
  }
}

function setup() {
  const repo = new DirtyRowSpyRepo()
  const userProv: UserProvider = {
    async getUser(userId) {
      return { userId, realName: '用户' + userId, deptId: 'D01', deptName: '测试部门', postId: 'P01', postName: '测试岗位' }
    },
  }
  const exprEval: ExpressionEvaluator = {
    async eval(expr, vars) {
      const amt = Number(vars.amount ?? 0)
      if (expr === 'amount > 1000') return amt > 1000
      if (expr === 'amount <= 1000') return amt <= 1000
      return false
    },
  }
  const engine = new EngineImpl(repo, userProv, mkSeqIdGen(), exprEval)
  const fired: ProcessEvent[] = []
  engine.setExtensions({ listeners: [(e) => { fired.push({ ...e }) }] })
  const facade = new JeeflowFacade(engine, repo, new MemoryExtRepository())
  return { engine, repo, facade, fired }
}

describe('processTask/removeTaskActor（issues/115 门面第 47 个 action）', () => {

  /** 起一单 01-simple：startAndExecute 自动跑完 apply ⇒ 停在 task1（参与者＝leader）。 */
  async function startTask(facade: JeeflowFacade, repo: MemoryRepository): Promise<string> {
    const content = readFileSync(flowDir + '01-simple.json', 'utf-8')
    const r0 = await facade.flow('processDefine/deploy', { content })
    assert.equal(r0.code, 0, JSON.stringify(r0))
    const r1 = await facade.flow('processInstance/startAndExecute',
      { processDefineId: r0.data.processDefineId, operator: 'zhangsan' })
    assert.equal(r1.code, 0, JSON.stringify(r1))
    const doing = await repo.findDoingTasks(r1.data.processInstanceId)
    assert.equal(doing.length, 1, '前置：实例应停在一个进行中任务')
    return doing[0].id
  }

  /** 加签成人手（用兄弟 action 造多参与者现场，不直接塞仓储） */
  async function addActors(facade: JeeflowFacade, taskId: string, ...actors: string[]) {
    const r = await facade.flow('processTask/addCandidate', { processTaskId: taskId, actorIds: actors })
    assert.equal(r.code, 0, JSON.stringify(r))
  }

  const remove = (facade: JeeflowFacade, processTaskId: any, actorIds: any, operator: any) =>
    facade.flow('processTask/removeTaskActor', { processTaskId, actorIds, operator })

  // ═══ 语义 1「只摘不加」＋ 正向核心 ═══

  it('01 只摘点名的人，其余参与人按顺序原样保留', async () => {
    const { facade, repo } = setup()
    const taskId = await startTask(facade, repo)
    await addActors(facade, taskId, '9001', '9002')
    assert.deepEqual(await repo.findTaskActors(taskId), ['leader', '9001', '9002'])

    const resp = await remove(facade, taskId, ['9001'], 'flow.admin')

    assert.equal(resp.code, 0, JSON.stringify(resp))
    assert.equal(resp.msg, '成功', '成功信封 msg 逐字')
    assert.equal(resp.data, null, 'data → null（spec 同节：前端消费面不读 data）')
    assert.deepEqual(await repo.findTaskActors(taskId), ['leader', '9002'], '只删点名的 9001，其余含顺序原样')
  })

  it('02 一次摘多人（集合语义，不是"一次只能摘一个人"）', async () => {
    const { facade, repo } = setup()
    const taskId = await startTask(facade, repo)
    await addActors(facade, taskId, '9001', '9002', '9003')

    assert.equal((await remove(facade, taskId, ['9001', '9002'], 'flow.admin')).code, 0)
    assert.deepEqual(await repo.findTaskActors(taskId), ['leader', '9003'])
  })

  it('03 逗号串腿与数组腿同判据（§2.11 第 1 行「两形一把尺子」）', async () => {
    const { facade, repo } = setup()
    const taskId = await startTask(facade, repo)
    await addActors(facade, taskId, '9001', '9002')

    assert.equal((await remove(facade, taskId, '9001, 9002 ', 'flow.admin')).code, 0)
    assert.deepEqual(await repo.findTaskActors(taskId), ['leader'], '逗号串带空格照样命中')
  })

  // ═══ 语义 3「归属判据同 transfer」 ═══

  it('04 本人摘自己的那一票：无需特权', async () => {
    const { facade, repo } = setup()
    const taskId = await startTask(facade, repo)
    await addActors(facade, taskId, '9001')

    assert.equal((await remove(facade, taskId, ['9001'], '9001')).code, 0)
    assert.deepEqual(await repo.findTaskActors(taskId), ['leader'])
  })

  it('05 借道摘他人必须拦下，且报错后一条都不许删', async () => {
    const { facade, repo } = setup()
    const taskId = await startTask(facade, repo)
    await addActors(facade, taskId, '9001')

    const resp = await remove(facade, taskId, ['9001'], 'leader')
    assert.equal(resp.code, 99999999, JSON.stringify(resp))
    assert.equal(resp.msg, '无权限摘除该任务参与人')
    assert.deepEqual(await repo.findTaskActors(taskId), ['leader', '9001'], '报错后参与者一动不动')
  })

  it('06 flow.auto / flow.admin 同档放行（大小写不敏感沿用本栈既有写法）', async () => {
    const { facade, repo } = setup()
    const taskId = await startTask(facade, repo)
    await addActors(facade, taskId, '9001', '9002')

    assert.equal((await remove(facade, taskId, ['9001'], 'flow.auto')).code, 0, 'flow.auto 放行')
    assert.equal((await remove(facade, taskId, ['9002'], 'FLOW.ADMIN')).code, 0, '大小写不敏感')
    assert.deepEqual(await repo.findTaskActors(taskId), ['leader'])
  })

  // ═══ 语义 5「不得摘空」：判据是集合差，不是入参条数 ═══

  it('07 不得摘空（摘空＝无人可办又无法重派的死单）', async () => {
    const { facade, repo } = setup()
    const taskId = await startTask(facade, repo)
    assert.deepEqual(await repo.findTaskActors(taskId), ['leader'])

    const resp = await remove(facade, taskId, ['leader'], 'leader')
    assert.equal(resp.code, 99999999, JSON.stringify(resp))
    assert.equal(resp.msg, '至少需保留一名参与人')
    assert.deepEqual(await repo.findTaskActors(taskId), ['leader'], '人还在')
  })

  it('08 混入非参与者 id 也绕不过下限（集合差判据，不是入参条数）', async () => {
    const { facade, repo } = setup()
    const taskId = await startTask(facade, repo)
    await addActors(facade, taskId, '9001')

    const resp = await remove(facade, taskId, ['leader', '9001', 'ghost'], 'leader')
    assert.equal(resp.msg, '至少需保留一名参与人')
    assert.deepEqual(await repo.findTaskActors(taskId), ['leader', '9001'])
  })

  // ═══ 语义 4「只作用于进行中任务」 ═══

  it('09 非 DOING 一律拦下，历史参与人行不被改写', async () => {
    const { facade, repo } = setup()
    const taskId = await startTask(facade, repo)
    const done = await facade.flow('processTask/execute',
      { processTaskId: taskId, operator: 'leader', submitType: SubmitType.Agree })
    assert.equal(done.code, 0, JSON.stringify(done))
    assert.equal((await repo.findTaskById(taskId))?.taskState, TaskState.Done, '前置：任务已离开 DOING')

    const resp = await remove(facade, taskId, ['leader'], 'flow.admin')
    assert.equal(resp.code, 99999999, JSON.stringify(resp))
    assert.equal(resp.msg, '任务非进行中，不可摘除参与人')
    assert.deepEqual(await repo.findTaskActors(taskId), ['leader'], '已办结任务的参与人行原样（审批链取证依据）')
  })

  // ═══ 语义 2「不留痕、不 fire 事件」 ═══

  it('10 零留痕＋零事件：不写变量、不动任务行留痕列、不发任何流程事件', async () => {
    const { facade, repo, fired } = setup()
    const taskId = await startTask(facade, repo)
    await addActors(facade, taskId, '9001')
    // 改前快照：建单路径本来就会写 update_user/update_time（不是摘人写的），
    // 判据只能是"摘人这一步没动它"，不能假定它本来是 null。
    const before = await repo.findTaskById(taskId)
    fired.length = 0

    assert.equal((await remove(facade, taskId, ['9001'], 'flow.admin')).code, 0)

    assert.deepEqual(fired.map(e => e.type), [], '摘人不在 132 定稿事件集里，一律不 fire（码 7 的语义是「参与者被替换」）')
    const after = await repo.findTaskById(taskId)
    const vars = after?.variables ?? {}
    assert.equal(vars.submitType, undefined, '不置 submitType')
    assert.equal(vars.tf_transferHistory, undefined, '不写 tf_transferHistory')
    assert.equal(vars.tf_transferTo, undefined, '不写 tf_transferTo')
    assert.equal(after?.updateUser, before?.updateUser, '不覆写任务留痕列 update_user')
    assert.equal(after?.updateTime, before?.updateTime, '不覆写任务留痕列 update_time')
    assert.equal(after?.actorId, before?.actorId, '不覆写任务 actor_id 列')
    assert.equal(after?.taskState, TaskState.Doing, '不新建任务、不改任务态')
  })

  // ═══ 语义 7「幂等」 ═══

  it('11 非参与者静默忽略，重放第二次仍得成功信封', async () => {
    const { facade, repo } = setup()
    const taskId = await startTask(facade, repo)
    await addActors(facade, taskId, '9001')

    assert.equal((await remove(facade, taskId, ['9001'], 'flow.admin')).code, 0)
    assert.deepEqual(await repo.findTaskActors(taskId), ['leader'])
    // 第二次：一个都没命中 ⇒ 空操作（前端双点/集成层重放不再报错）
    assert.equal((await remove(facade, taskId, ['9001'], 'flow.admin')).code, 0)
    assert.deepEqual(await repo.findTaskActors(taskId), ['leader'])
    // 非参与者 id 单独喂进来也不报错
    assert.equal((await remove(facade, taskId, ['ghost'], 'flow.admin')).code, 0)
    assert.deepEqual(await repo.findTaskActors(taskId), ['leader'])
  })

  // ═══ 必填档逐字文案（五个报错档） ═══

  it('12 五个报错档复用跨栈统一文案，且一条都不许删', async () => {
    const { facade, repo } = setup()
    const taskId = await startTask(facade, repo)
    // 取证快照必须是副本：内存仓 findTaskActors 返回内部活列表，拿引用比引用会恒真
    const before = [...await repo.findTaskActors(taskId)]

    const cases: Array<[any, any, any, string]> = [
      [taskId, ['leader'], null, 'operator 必填'],
      [taskId, ['leader'], '   ', 'operator 必填'],
      ['', ['9001'], 'flow.admin', 'processTaskId/actorIds 缺失'],
      [taskId, ['', '  ', null], 'flow.admin', 'processTaskId/actorIds 缺失'],
      [424242, ['9001'], 'flow.admin', '任务不存在'],
    ]
    for (const [tid, actorIds, operator, expectMsg] of cases) {
      const resp = await remove(facade, tid, actorIds, operator)
      assert.equal(resp.code, 99999999, JSON.stringify(resp))
      assert.equal(resp.msg, expectMsg, `期望「${expectMsg}」: ${JSON.stringify(resp)}`)
      assert.equal(resp.data ?? null, null,
        '失败信封不透 data（本栈 flow() 的失败分支根本不写 data 键，是既有形状，与成功信封的 data:null 分档）')
    }
    assert.deepEqual([...await repo.findTaskActors(taskId)], before, '五个报错档一条都不许删')
  })

  // ═══ 守卫次序（spec 同节钉死，八栈不接受自行排序） ═══

  it('13 守卫次序：operator 必填先于缺参数；权限先于非进行中', async () => {
    const { facade, repo } = setup()
    const taskId = await startTask(facade, repo)

    const both = await remove(facade, '', ['9001'], null)
    assert.equal(both.msg, 'operator 必填',
      'operator 必填排在主键缺失档之前（否则鉴权缺口会被参数报错藏起来）')

    await facade.flow('processTask/execute', { processTaskId: taskId, operator: 'leader', submitType: SubmitType.Agree })
    const late = await remove(facade, taskId, ['leader'], 'outsider')
    assert.equal(late.msg, '无权限摘除该任务参与人',
      '权限档先于非进行中档（否则外人可以靠「任务已完成」探到别人的任务状态）')
  })

  // ═══ 门禁新格：带空格入参 ∧ 脏行安全 ∧ DELETE 实参取行上原值 ═══

  it('14 带空格入参删得掉真人 ∧ 空值不误删 actor_id="" 脏行 ∧ DELETE 实参非空', async () => {
    const { facade, repo } = setup()
    const taskId = await startTask(facade, repo)
    await addActors(facade, taskId, '9001', '9002')
    repo.seedDirtyRow(taskId, '')      // 复刻历史脏行（内存仓写侧归一后正常路径建不出来）
    repo.seedDirtyRow(taskId, '   ')   // 纯空白那一支也算脏行

    assert.equal((await remove(facade, taskId, [' 9001 ', '', null, '   ', '9002'], 'flow.admin')).code, 0)

    assert.deepEqual(await repo.findRealActors(taskId), ['leader'], '带空格的入参删得掉真人，其余参与人不动')
    assert.deepEqual(repo.dirtyRemaining(taskId), ['', '   '],
      '空串/纯空白绝不能喂进 DELETE ⇒ 历史脏行必须原样还在')
    assert.ok(repo.removeCalls.length > 0, '应有一次删除')
    for (const call of repo.removeCalls) {
      for (const actor of call) {
        assert.ok(actor.trim() !== '', `喂给 DELETE 的实参不得含空串/纯空白: ${JSON.stringify(call)}`)
      }
    }
  })

  it('15 未 trim 的历史行按归一值判成同一人、按行上原值真删（反面＝假成功）', async () => {
    const { facade, repo } = setup()
    const taskId = await startTask(facade, repo)
    repo.seedDirtyRow(taskId, ' 9101 ')   // 修复前落下的未 trim 原值行

    assert.equal((await remove(facade, taskId, ['9101'], 'flow.admin')).code, 0)

    assert.deepEqual(await repo.findRealActors(taskId), ['leader'], '真参与者不受牵连')
    assert.deepEqual(repo.dirtyRemaining(taskId), [], '未 trim 的历史行被归一匹配命中并删除')
    const last = repo.removeCalls[repo.removeCalls.length - 1]
    assert.deepEqual(last, [' 9101 '], 'DELETE 的实参是行上的原值，不是归一后的值（否则本栈两仓精确比较的删除腿一条都删不掉）')
  })

  it('16 脏行不算"一个人"：只剩脏行时摘走最后一个真人必须报错', async () => {
    const { facade, repo } = setup()
    const taskId = await startTask(facade, repo)
    repo.seedDirtyRow(taskId, '')
    repo.seedDirtyRow(taskId, '   ')

    const resp = await remove(facade, taskId, ['leader'], 'flow.admin')
    assert.equal(resp.msg, '至少需保留一名参与人', '脏行谁也办不了，拿它撑住下限等于让"摘空"伪装成成功')
    assert.deepEqual(await repo.findRealActors(taskId), ['leader'], '报错后真人那行还在')
    assert.deepEqual(repo.dirtyRemaining(taskId), ['', '   '], '报错后脏行也不动')
  })

  // ═══ 兄弟 action 回归 ═══

  it('17 兄弟 action 语义不变：surrogate 仍只加、transfer 仍换人＋写 submitType=7', async () => {
    const { facade, repo } = setup()
    const taskId = await startTask(facade, repo)

    assert.equal((await facade.flow('processTask/surrogate',
      { processTaskId: taskId, actorIds: ['9101'] })).code, 0)
    assert.deepEqual(await repo.findTaskActors(taskId), ['leader', '9101'], 'surrogate 仍旧只加不摘')

    assert.equal((await remove(facade, taskId, ['9101'], 'flow.admin')).code, 0)
    assert.deepEqual(await repo.findTaskActors(taskId), ['leader'], '摘人不带加人')

    const tr = await facade.flow('processTask/transfer',
      { processTaskId: taskId, fromActor: 'leader', toActor: 'boss', operator: 'leader' })
    assert.equal(tr.code, 0, JSON.stringify(tr))
    assert.deepEqual(await repo.findTaskActors(taskId), ['boss'], 'transfer 换人语义不变')
    assert.equal((await repo.findTaskById(taskId))?.variables.submitType, SubmitType.Transfer,
      'transfer 仍写 submitType=7 留痕')
  })
})
