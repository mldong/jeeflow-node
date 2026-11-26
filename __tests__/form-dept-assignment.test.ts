/**
 * issues/258 · 表单指定 1–N 个部门（分管）领导的两个内置处理器。
 * 字段查找沿用 issues/254 的四档并集；既有 handler 行为不变。
 */
import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import {
  FormDeptLeaderAssignmentHandler,
  FormDeptMainLeaderAssignmentHandler,
  FormUserDeptLeaderAssignmentHandler,
  HANDLER_FORM_DEPT_LEADER,
  HANDLER_FORM_DEPT_MAIN_LEADER,
  HandlerRegistry,
  registerBuiltinAssignments,
} from '../src/index.js'
import type { FlowNode, ProcessInstance } from '../src/model.js'
import type { OrgUserProvider, UserProvider } from '../src/spi.js'

const FQ_LEADER = 'com.mldong.jeeflow.interceptor.impl.FormDeptLeaderAssignmentHandler'
const FQ_MAIN = 'com.mldong.jeeflow.interceptor.impl.FormDeptMainLeaderAssignmentHandler'

const LEADERS: Record<string, string[]> = {
  deptA: ['leaderA', 'shared'],
  deptB: ['leaderB', 'shared'],
  deptC: ['leaderC1', 'leaderC2'],
  '0': ['zeroLeader'],
}
const MAIN_LEADERS: Record<string, string[]> = {
  deptA: ['mainA'],
  deptB: ['mainB'],
  deptC: ['mainC1', 'mainC2'],
  '0': ['zeroMain'],
}
const orgProv: OrgUserProvider = {
  async findDeptLeaders(deptId) { return LEADERS[deptId] ?? [] },
  async findDeptMainLeaders(deptId) { return MAIN_LEADERS[deptId] ?? [] },
  async findByRole() { return [] },
}
const userProv: UserProvider = {
  async getUser(userId) {
    if (userId === 'emp') return { userId, realName: '员工甲', deptId: 'deptA', deptName: '', postId: '', postName: '' }
    if (userId === 'other') return { userId, realName: '员工乙', deptId: 'deptB', deptName: '', postId: '', postName: '' }
    return null
  },
}

function node(id: string): FlowNode {
  return { id, type: 'snaker:task', properties: {}, text: { value: id } } as FlowNode
}
function inst(variables: Record<string, any>): ProcessInstance {
  return { id: '1', defineId: '1', operator: 'clerk', variables } as ProcessInstance
}
async function actors(
  nodeId: string,
  variables: Record<string, any>,
  main = false,
  provider: OrgUserProvider | null = orgProv,
): Promise<string[]> {
  const Handler = main ? FormDeptMainLeaderAssignmentHandler : FormDeptLeaderAssignmentHandler
  return new Handler(undefined, provider ?? undefined).assign(node(nodeId), inst(variables), 'clerk')
}

describe('四档字段查找（顺序即优先级）', () => {
  it('f_ 前缀压裸名', async () => {
    assert.deepEqual(await actors('depts', { f_depts: 'deptA', depts: 'deptB' }), ['leaderA', 'shared'])
  })

  it('裸名回落；字段缺失为空', async () => {
    assert.deepEqual(await actors('depts', { depts: 'deptB' }), ['leaderB', 'shared'])
    assert.deepEqual(await actors('depts', { other: 'deptA' }), [])
  })

  it('# 右半先裸名、再 f_ 变体', async () => {
    assert.deepEqual(await actors('manager#deptIds', { deptIds: 'deptA', f_deptIds: 'deptB' }), ['leaderA', 'shared'])
    assert.deepEqual(await actors('manager#deptIds', { f_deptIds: 'deptB' }), ['leaderB', 'shared'])
  })

  it('# 取最后一个右半字段', async () => {
    assert.deepEqual(await actors('a#b#deptIds', { deptIds: 'deptA' }), ['leaderA', 'shared'])
  })

  it('_NN 去后缀先 f_、再裸名，且 base 为惰性匹配', async () => {
    assert.deepEqual(await actors('depts_01', { f_depts: 'deptA', depts: 'deptB' }), ['leaderA', 'shared'])
    assert.deepEqual(await actors('depts_01', { depts: 'deptB' }), ['leaderB', 'shared'])
    assert.deepEqual(await actors('a_b_01', { a_b: 'deptA', a: 'deptB' }), ['leaderA', 'shared'])
  })

  it('键存在即命中：null／undefined 不回退下一档', async () => {
    assert.deepEqual(await actors('depts', { f_depts: null, depts: 'deptB' }), [])
    assert.deepEqual(await actors('depts', { f_depts: undefined, depts: 'deptB' }), [])
  })
})

describe('部门列表解析与合并', () => {
  it('字符串按英文逗号拆分，trim 后丢空并保序', async () => {
    assert.deepEqual(await actors('depts', { depts: ' deptA, , deptB,, ' }), ['leaderA', 'shared', 'leaderB'])
  })

  it('数组逐元素读取并保序', async () => {
    assert.deepEqual(await actors('depts', { depts: [' deptA ', 'deptB'] }), ['leaderA', 'shared', 'leaderB'])
  })

  it('Set 集合逐元素读取并保序', async () => {
    assert.deepEqual(await actors('depts', { depts: new Set(['deptA', 'deptB']) }), ['leaderA', 'shared', 'leaderB'])
  })

  it('数组元素不二次拆逗号', async () => {
    const seen: string[] = []
    const spy: OrgUserProvider = {
      ...orgProv,
      async findDeptLeaders(deptId) {
        seen.push(deptId)
        return LEADERS[deptId] ?? []
      },
    }
    assert.deepEqual(await actors('depts', { depts: ['deptA,deptB', 'deptC'] }, false, spy), ['leaderC1', 'leaderC2'])
    assert.deepEqual(seen, ['deptA,deptB', 'deptC'])
  })

  it('重复部门只查一次，跨部门重复领导只保留首次', async () => {
    const seen: string[] = []
    const spy: OrgUserProvider = {
      ...orgProv,
      async findDeptLeaders(deptId) {
        seen.push(deptId)
        return LEADERS[deptId] ?? []
      },
    }
    assert.deepEqual(await actors('depts', { depts: 'deptA,deptB,deptA' }, false, spy), ['leaderA', 'shared', 'leaderB'])
    assert.deepEqual(seen, ['deptA', 'deptB'])
  })

  it('非法部门跳过，不影响后续合法部门', async () => {
    assert.deepEqual(await actors('depts', { depts: 'ghost,deptB' }), ['leaderB', 'shared'])
  })

  it('数字 0 是合法部门 ID', async () => {
    const seen: string[] = []
    const spy: OrgUserProvider = {
      ...orgProv,
      async findDeptLeaders(deptId) {
        seen.push(deptId)
        return LEADERS[deptId] ?? []
      },
    }
    assert.deepEqual(await actors('depts', { depts: 0 }, false, spy), ['zeroLeader'])
    assert.deepEqual(seen, ['0'])
  })

  it('字符串 "0" 是合法部门 ID', async () => {
    assert.deepEqual(await actors('depts', { depts: '0' }), ['zeroLeader'])
  })

  it('分管领导档只调用 findDeptMainLeaders，并按部门／SPI 顺序合并', async () => {
    const leadersCalls: string[] = []
    const mainCalls: string[] = []
    const spy: OrgUserProvider = {
      async findDeptLeaders(deptId) { leadersCalls.push(deptId); return [] },
      async findDeptMainLeaders(deptId) { mainCalls.push(deptId); return MAIN_LEADERS[deptId] ?? [] },
      async findByRole() { return [] },
    }
    assert.deepEqual(await actors('depts', { depts: 'deptA,deptB' }, true, spy), ['mainA', 'mainB'])
    assert.deepEqual(mainCalls, ['deptA', 'deptB'])
    assert.deepEqual(leadersCalls, [])
  })

  it('同一部门多个领导保持 SPI 返回顺序', async () => {
    assert.deepEqual(await actors('depts', { depts: 'deptC' }), ['leaderC1', 'leaderC2'])
  })

  it('领导 ID trim、空值丢弃、同批去重', async () => {
    const spy: OrgUserProvider = {
      async findDeptLeaders() { return [' leaderX ', '', 'leaderX', null as unknown as string, 'leaderY'] },
      async findDeptMainLeaders() { return [] },
      async findByRole() { return [] },
    }
    assert.deepEqual(await actors('depts', { depts: 'deptA' }, false, spy), ['leaderX', 'leaderY'])
  })
})

describe('空值与失败语义', () => {
  it('空串、纯空白、空数组、null、undefined 都为空且不抛', async () => {
    for (const value of ['', '   ', [], ['', '  '], null, undefined]) {
      assert.deepEqual(await actors('depts', { depts: value }), [])
      assert.deepEqual(await actors('depts', { depts: value }, true), [])
    }
  })

  it('全部部门无领导时为空', async () => {
    assert.deepEqual(await actors('depts', { depts: 'ghost,missing' }), [])
    assert.deepEqual(await actors('depts', { depts: 'ghost,missing' }, true), [])
  })

  it('OrgUserProvider 未注册时两档都为空', async () => {
    assert.deepEqual(await actors('depts', { depts: 'deptA' }, false, null), [])
    assert.deepEqual(await actors('depts', { depts: 'deptA' }, true, null), [])
  })

  it('无节点时两档都为空且不抛', async () => {
    const leader = new FormDeptLeaderAssignmentHandler(undefined, orgProv)
    const main = new FormDeptMainLeaderAssignmentHandler(undefined, orgProv)
    assert.deepEqual(await leader.assign(null, inst({}), 'clerk'), [])
    assert.deepEqual(await main.assign(null, inst({}), 'clerk'), [])
  })

  it('无实例时两档都为空且不抛', async () => {
    const leader = new FormDeptLeaderAssignmentHandler(undefined, orgProv)
    const main = new FormDeptMainLeaderAssignmentHandler(undefined, orgProv)
    assert.deepEqual(await leader.assign(node('depts'), null, 'clerk'), [])
    assert.deepEqual(await main.assign(node('depts'), null, 'clerk'), [])
  })

  it('节点 id 为空时两档都为空', async () => {
    assert.deepEqual(await actors('', { f_: 'deptA' }), [])
    assert.deepEqual(await actors('', { f_: 'deptA' }, true), [])
  })

  it('SPI 返回 null／undefined 时按无领导处理', async () => {
    const emptyOrg: OrgUserProvider = {
      async findDeptLeaders() { return null as unknown as string[] },
      async findDeptMainLeaders() { return undefined as unknown as string[] },
      async findByRole() { return [] },
    }
    assert.deepEqual(await actors('depts', { depts: 'deptA' }, false, emptyOrg), [])
    assert.deepEqual(await actors('depts', { depts: 'deptA' }, true, emptyOrg), [])
  })

  it('SPI 抛错时返回空且不向引擎抛错', async () => {
    const brokenOrg: OrgUserProvider = {
      async findDeptLeaders() { throw new Error('leader lookup failed') },
      async findDeptMainLeaders() { throw new Error('main leader lookup failed') },
      async findByRole() { return [] },
    }
    assert.deepEqual(await actors('depts', { depts: 'deptA' }, false, brokenOrg), [])
    assert.deepEqual(await actors('depts', { depts: 'deptA' }, true, brokenOrg), [])
  })

  it('非标量对象按非法部门处理，不抛', async () => {
    assert.deepEqual(await actors('depts', { depts: { id: 'deptA' } }), [])
    assert.deepEqual(await actors('depts', { depts: { id: 'deptA' } }, true), [])
  })
})

describe('注册名、元数据与旧 handler 回归', () => {
  it('注册名是 Java 顶级类 FQCN，内置注册可解析且元数据 order 90/100', () => {
    assert.equal(HANDLER_FORM_DEPT_LEADER, FQ_LEADER)
    assert.equal(HANDLER_FORM_DEPT_MAIN_LEADER, FQ_MAIN)
    const reg = new HandlerRegistry()
    registerBuiltinAssignments(reg, undefined, orgProv)
    assert.ok(reg.resolveAssignment(FQ_LEADER) instanceof FormDeptLeaderAssignmentHandler)
    assert.ok(reg.resolveAssignment(FQ_MAIN) instanceof FormDeptMainLeaderAssignmentHandler)
    const metas = reg.listHandlers('AssignmentHandler')
    assert.equal(metas.length, 11)
    assert.deepEqual(metas.slice(-2), [
      { type: 'AssignmentHandler', name: FQ_LEADER, displayName: '表单指定部门负责人', order: 90 },
      { type: 'AssignmentHandler', name: FQ_MAIN, displayName: '表单指定部门分管领导', order: 100 },
    ])
  })

  it('issues/254 老 handler 仍只取第一个表单用户', async () => {
    const handler = new FormUserDeptLeaderAssignmentHandler(userProv, orgProv)
    assert.deepEqual(await handler.assign(node('user'), inst({ f_user: 'emp,other' }), 'clerk'), ['leaderA', 'shared'])
  })
})
