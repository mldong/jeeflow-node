/**
 * action → 权限码映射 SPI 验收（hub issues/248 的 node 腿）——断言的是"与 java
 * `DefaultActionPermissionProvider` 逐条一致"，不是"与这份实现一致"：
 * 改两张表必须同时改 java 那份，否则本卡必红。
 * 交叉样本＝go `spi/action_permission_test.go`（同构断言）。
 *
 * 覆盖：① 默认派生 ② OR 族两例 ③ 放行族（含统计三条）④ 两枚新 action 恰为
 * ["wf:processTask:execute"]＋反向哨兵（transfer／removeTaskActor 仍走默认派生，
 * 防"整族都被塞进 execute"这种错法被放过）⑤ 覆盖注册生效＋null/undefined 回落
 * ⑥ 两张表条目数钉死 7 与 11（跨栈契约的形状锚）⑦ SPI 元数据条目。
 */
import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import {
  permissionCodes,
  setActionPermissionProvider,
  actionPermissionProviderOrDefault,
  actionPermissionProviderMeta,
  ACTION_PERMISSION_OR_RULES,
  ACTION_PERMISSION_NO_PERM_ACTIONS,
  DefaultActionPermissionProvider,
  type ActionPermissionProvider,
} from '../src/action-permission.js'

describe('DefaultActionPermissionProvider 三档语义（对齐 java）', () => {
  it('① 默认派生：wf:{action 的 / 换 :}', () => {
    assert.deepEqual(permissionCodes('processDesign/save'), ['wf:processDesign:save'])
  })

  it('② OR 族（boot3 @SaCheckPermission(mode=OR)：任选其一即有权）', () => {
    assert.deepEqual(permissionCodes('processDefine/detail'),
      ['wf:processDefine:detail', 'wf:processDesign:listByType'])
    assert.deepEqual(permissionCodes('processTask/candidatePage'),
      ['wf:processTask:execute', 'wf:processTask:candidatePage'])
  })

  it('③ 放行族：null/空 = 登录即可（含统计三条，issues/103）', () => {
    assert.equal(permissionCodes('processInstance/detail'), null)
    for (const stats of ['processInstance/stats/overview', 'processInstance/stats/trend',
      'processInstance/stats/group']) {
      const got = permissionCodes(stats)
      assert.ok(got == null || got.length === 0, `统计 action ${stats} 应放行，实得 ${JSON.stringify(got)}`)
    }
  })
})

describe('issues/246／247 两枚新 action 的 B 案粒度', () => {
  it('④ recall／revokeDynamicCountersign 恰为 ["wf:processTask:execute"]（复用"办理"码，不新建种子）', () => {
    assert.deepEqual(permissionCodes('processTask/recall'), ['wf:processTask:execute'])
    assert.deepEqual(permissionCodes('processTask/revokeDynamicCountersign'), ['wf:processTask:execute'])
  })

  it('④ 反向哨兵：未配进两张表的 action 必须仍走默认派生', () => {
    assert.deepEqual(permissionCodes('processTask/transfer'), ['wf:processTask:transfer'])
    assert.deepEqual(permissionCodes('processTask/removeTaskActor'), ['wf:processTask:removeTaskActor'])
  })
})

describe('可选覆盖位（java ServiceContext.find 同语义）', () => {
  it('⑤ 覆盖注册生效；传 null／undefined 回落内置默认件', () => {
    try {
      const custom: ActionPermissionProvider = { permissionCodes: () => ['custom:1'] }
      setActionPermissionProvider(custom)
      assert.deepEqual(permissionCodes('anything/here'), ['custom:1'])
      setActionPermissionProvider(null)
      assert.deepEqual(permissionCodes('processDesign/save'), ['wf:processDesign:save'])
      setActionPermissionProvider(custom)
      assert.deepEqual(permissionCodes('anything/here'), ['custom:1'])
      setActionPermissionProvider(undefined)
      assert.ok(actionPermissionProviderOrDefault() instanceof DefaultActionPermissionProvider)
      assert.deepEqual(permissionCodes('processDesign/save'), ['wf:processDesign:save'])
    } finally {
      setActionPermissionProvider(null) // 用例之间不互相污染
    }
  })
})

describe('两张表形状与元数据（跨栈契约锚）', () => {
  it('⑥ OR 表 8 条／放行清单 11 条（钉死数字：加一条要八栈同批改）', () => {
    // issues/253 动态协办 processTask/aidant 复用 execute 码进 OR 表 ⇒ 7→8（本轮同批 +1）
    assert.equal(Object.keys(ACTION_PERMISSION_OR_RULES).length, 8,
      `OR 规则条数应为 8（对齐 java DefaultActionPermissionProvider），现读 ${Object.keys(ACTION_PERMISSION_OR_RULES).length}`)
    assert.equal(ACTION_PERMISSION_NO_PERM_ACTIONS.size, 11,
      `放行清单条数应为 11（含统计三条），现读 ${ACTION_PERMISSION_NO_PERM_ACTIONS.size}`)
  })

  it('⑦ SPI 元数据条目可见内置默认件（java／go／c#／rust 元数据约定同形）', () => {
    assert.deepEqual(actionPermissionProviderMeta(), {
      type: 'ActionPermissionProvider',
      name: 'com.mldong.jeeflow.spi.DefaultActionPermissionProvider',
    })
  })
})
