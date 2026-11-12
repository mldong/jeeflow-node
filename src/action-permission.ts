// action → 权限码映射 SPI（hub issues/248 的 node 腿）
//
// 语义参照实现＝java `com.mldong.jeeflow.spi.DefaultActionPermissionProvider`
// （jeeflow-core/src/main/java/com/mldong/jeeflow/spi/），其测试是权威；
// 另一条已完成的同类腿是 go `spi/action_permission.go`。两张表与其**逐条一致**，
// 改这张表必须同时改 java 那份，否则跨栈对齐测试必红。
//
// 边界（与 java/go 同口径）：引擎**不依赖任何鉴权框架**（sa-token / JWT / 中间件都是
// 宿主框架的事），本 SPI 只提供"action → 权限码"这一份**元数据**；
// 校验执行仍由集成方框架层完成。
//
// 为什么要在引擎里放这张表（而不是各集成壳自备）：现读十壳各抄一份
// （go 三壳 wf_permission.go／python 三壳 wf_permission.py／nestjs wf-permission.ts／
// laravel WfPermission.php／salvo wf_permission.rs／csharp WfEndpoints.cs），
// 新 action 或粒度调整要改十处＋引擎，且"只用引擎、自写集成层"的客户跨栈读出两套码。

/**
 * action → 权限码映射提供者接口（对齐 java `IActionPermissionProvider`）。
 *
 * `permissionCodes` 返回 action 的权限码集合（**OR 语义**——任一持有即有权）；
 * 返回 `null`／空数组 = 放行（登录即可，boot3 无注解 = 登录即可）。
 */
export interface ActionPermissionProvider {
  permissionCodes(action: string): string[] | null
}

/**
 * OR 规则表（对齐 java DefaultActionPermissionProvider.OR_RULES，7 条——
 * boot3 `@SaCheckPermission(value={...}, mode=OR)` 语义的 action，任选其一即有权）。
 * 条目数在测试里钉死：加一条规则要八栈同批改。
 */
export const ACTION_PERMISSION_OR_RULES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'processDefine/detail': Object.freeze(['wf:processDefine:detail', 'wf:processDesign:listByType']),
  'processDefine/startAndExecute': Object.freeze(['wf:processDefine:startAndExecute', 'wf:processDesign:listByType']),
  'processDefine/getLastByName': Object.freeze(['wf:processDefine:detail', 'wf:processDesign:listByType', 'wf:processDefine:getLastByName']),
  'processTask/candidatePage': Object.freeze(['wf:processTask:execute', 'wf:processTask:candidatePage']),
  'processTask/jumpAbleTaskNameList': Object.freeze(['wf:processTask:execute']),
  // issues/246／247 两枚新 action 定 B 案（owner 2026-11-04）：**复用"办理"这枚码**，不另建菜单按钮种子。
  // 判据是既有惯例——transfer／removeTaskActor／candidatePage／latest 都没有 sys_menu 按钮行，
  // candidatePage／jumpAbleTaskNameList 就是走本表复用 execute；而撤回／撤会签的主体
  // 按引擎判据本来就必然是该行参与者（＝有办理权的人），拆独立码实际给不出去。
  'processTask/recall': Object.freeze(['wf:processTask:execute']),
  'processTask/revokeDynamicCountersign': Object.freeze(['wf:processTask:execute']),
  // issues/253 动态协办：照 246/247 B 案惯例复用"办理"这枚码，不建按钮种子行——
  // 派生协办的主体按引擎判据本来就必然是主办行名册内的人（＝有办理权的人）。
  'processTask/aidant': Object.freeze(['wf:processTask:execute']),
})

/**
 * 放行清单（对齐 java NO_PERM_ACTIONS，11 条——boot3 无权限注解的 action，登录即可）。
 * 统计三条是 issues/103 的收口成果（普通用户分析页被默认规则
 * wf:processInstance:stats:* 拦截的修复，六语言同款）。
 */
export const ACTION_PERMISSION_NO_PERM_ACTIONS: ReadonlySet<string> = new Set([
  'processInstance/detail', 'processInstance/highLight', 'processInstance/approvalRecord',
  'processInstance/getAssigneeTextData', 'processInstance/bizData',
  'processTask/detail', 'processTask/addCandidate', 'processTask/latest',
  'processInstance/stats/overview', 'processInstance/stats/trend', 'processInstance/stats/group',
])

/**
 * 引擎内置默认实现（java `DefaultActionPermissionProvider` 的逐条同款）：
 * 放行 → OR → 默认派生 `wf:{action 的 / 全换 :}`。
 */
export class DefaultActionPermissionProvider implements ActionPermissionProvider {
  permissionCodes(action: string): string[] | null {
    if (action == null) return null                                  // 对齐 java `action == null` 防御档
    if (ACTION_PERMISSION_NO_PERM_ACTIONS.has(action)) return null   // 放行
    const or = ACTION_PERMISSION_OR_RULES[action]
    if (or != null) return [...or]                                   // OR 语义（拷贝，防调用方改内置表）
    return ['wf:' + action.replaceAll('/', ':')]                     // 默认派生
  }
}

// ─── 可选覆盖位（java `ServiceContext.find(IActionPermissionProvider)` 的同位）──────
//
// 与 java 一致的兜底语义：**没注册就等于用内置默认件**，集成方不配也有统一权限语义；
// 特殊集成方（另一套权限码体系）覆盖注册后按自家规则走。

let actionPermissionProvider: ActionPermissionProvider = new DefaultActionPermissionProvider()

/** 覆盖注册（传 `null`／`undefined` 回落到内置默认件）。 */
export function setActionPermissionProvider(provider?: ActionPermissionProvider | null): void {
  actionPermissionProvider = provider ?? new DefaultActionPermissionProvider()
}

/** 取当前生效的提供者（恒非 null，故调用方不必判空）。 */
export function actionPermissionProviderOrDefault(): ActionPermissionProvider {
  return actionPermissionProvider
}

/** 便捷出口：按当前生效提供者取 action 的权限码集合（OR 语义；null/空 = 放行）。 */
export function permissionCodes(action: string): string[] | null {
  return actionPermissionProviderOrDefault().permissionCodes(action)
}

/**
 * SPI 元数据清单条目（与 java HandlerRegistry／go `ActionPermissionProviderMeta`／
 * c# Metadata.cs／rust metadata.rs 同一约定：把内置默认件也暴露给前端设计器的 SPI 字典源；
 * 字段名与本仓 registry.ts 的 HandlerMeta `{type, name}` 风格对齐）。
 */
export function actionPermissionProviderMeta(): { type: string; name: string } {
  return { type: 'ActionPermissionProvider', name: 'com.mldong.jeeflow.spi.DefaultActionPermissionProvider' }
}
