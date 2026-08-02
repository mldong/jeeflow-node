// 引擎元数据能力测试（v1.4.0，issues/04）——枚举字典 + SPI 实现清单
import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { enumDict, enumDictKeys, HandlerRegistry, type HandlerMeta } from '../src/index.js'

describe('EnumDict（v1.4.0）', () => {
  it('内置 7 个字典 key 对齐 boot3', () => {
    const keys = enumDictKeys()
    assert.equal(keys.length, 7)
    for (const k of ['wf_process_define_state', 'wf_process_instance_state', 'wf_process_submit_type',
      'wf_process_task_state', 'wf_process_task_type', 'wf_process_task_perform_type', 'wf_countersign_type']) {
      assert.ok(keys.includes(k), `missing ${k}`)
    }
  })

  it('实例状态字典值与 Java 对齐', () => {
    const items = enumDict('wf_process_instance_state')
    assert.equal(items.length, 7)
    assert.deepEqual(items[0], { value: '10', label: '进行中' })
    assert.deepEqual(items[4], { value: '45', label: '已拒绝' })
    assert.deepEqual(items[6], { value: '99', label: '已废弃' })
  })

  it('提交类型字典 8 项', () => {
    const items = enumDict('wf_process_submit_type')
    assert.equal(items.length, 8)
    assert.deepEqual(items[0], { value: '0', label: '发起申请' })
    assert.deepEqual(items[7], { value: '20', label: '拒绝申请' })
  })

  it('未知 key 返回空列表', () => {
    assert.deepEqual(enumDict('wf_no_such_dict'), [])
  })
})

describe('HandlerRegistry 清单（v1.4.0）', () => {
  it('注册 + 按类型列出（order 升序）+ 分组过滤', () => {
    const r = new HandlerRegistry()
    r.registerAssignment('com.example.DeptLeaderHandler', { assign: () => ['leader'] },
      { displayName: '部门领导审批', order: 2 })
    r.registerAssignment('com.example.BossHandler', { assign: () => ['boss'] },
      { displayName: '老板审批', order: 1 })

    const list = r.listHandlers('AssignmentHandler')
    assert.equal(list.length, 2)
    assert.equal(list[0].name, 'com.example.BossHandler')
    assert.equal(list[0].displayName, '老板审批')
    // 未带元数据的注册也能列出（name 兜底）
    r.registerDecision('com.example.Decider', { decide: () => 'e1' })
    const decisions = r.listHandlers('DecisionHandler')
    assert.deepEqual(decisions, [{ name: 'com.example.Decider' }])
    // 分组过滤
    assert.deepEqual(r.listHandlersGroup('AssignmentHandler', 'pre'), [])
  })

  it('空注册表', () => {
    const r = new HandlerRegistry()
    assert.deepEqual(r.listHandlers('AssignmentHandler'), [])
    assert.deepEqual(r.listHandlerNames(), [])
  })
})
