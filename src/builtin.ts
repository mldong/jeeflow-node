import type { FlowNode, ProcessInstance } from './model.js'
import type { IAssignmentHandler } from './registry.js'
import type { OrgUserProvider, UserProvider } from './spi.js'

// ─── 内置通用参与者处理器（issues/16）───────────────────────────────────────────
// 注册名与 Java 类全限定名一致，跨语言流程 JSON 通用（前端设计器配置天然兼容）。
// OperatorAssignmentHandler / FormFieldAssigneeHandler 为纯引擎语义，零外部依赖；
// 组织维度 handler 通过 OrgUserProvider SPI 取数据，业务方只实现数据接口。

export const HANDLER_OPERATOR_ASSIGNMENT = 'com.mldong.jeeflow.interceptor.impl.OperatorAssignmentHandler'
export const HANDLER_FORM_FIELD_ASSIGNEE = 'com.mldong.jeeflow.interceptor.impl.FormFieldAssigneeHandler'
const ORG_HANDLERS_PREFIX = 'com.mldong.jeeflow.interceptor.impl.OrgUserAssignmentHandlers$'
export const HANDLER_DEPT_LEADER = ORG_HANDLERS_PREFIX + 'DeptLeaderAssignmentHandler'
export const HANDLER_DEPT_MAIN_LEADER = ORG_HANDLERS_PREFIX + 'DeptMainLeaderAssignmentHandler'
export const HANDLER_APPLICANT_DEPT_LEADER = ORG_HANDLERS_PREFIX + 'ApplicantDeptLeaderAssignmentHandler'
export const HANDLER_APPLICANT_DEPT_MAIN_LEADER = ORG_HANDLERS_PREFIX + 'ApplicantDeptMainLeaderAssignmentHandler'
export const HANDLER_TASK_ROLE_ASSIGNEE = ORG_HANDLERS_PREFIX + 'TaskRoleAssigneeHandler'
// 两个「表单指定用户」类是顶级类（不带 OrgUserAssignmentHandlers$ 前缀），注册名与其余语言逐字一致
export const HANDLER_FORM_USER_DEPT_LEADER =
  'com.mldong.jeeflow.interceptor.impl.FormUserDeptLeaderAssignmentHandler'
export const HANDLER_FORM_USER_DEPT_MAIN_LEADER =
  'com.mldong.jeeflow.interceptor.impl.FormUserDeptMainLeaderAssignmentHandler'
// issues/258：两个「表单指定部门」类同样是顶级类（不带 OrgUserAssignmentHandlers$ 前缀）
export const HANDLER_FORM_DEPT_LEADER =
  'com.mldong.jeeflow.interceptor.impl.FormDeptLeaderAssignmentHandler'
export const HANDLER_FORM_DEPT_MAIN_LEADER =
  'com.mldong.jeeflow.interceptor.impl.FormDeptMainLeaderAssignmentHandler'

// 表单字段编号后缀正则（task_01 → task）
const NUMBER_SUFFIX_PATTERN = /^(.+?)_(\d+)$/

// ─── 纯引擎语义 ────────────────────────────────────────────────────────────────

/** 流程发起人（兜底 "apply.operator"） */
export class OperatorAssignmentHandler implements IAssignmentHandler {
  async assign(_node: FlowNode, inst: ProcessInstance | null, _operator: string): Promise<string[]> {
    if (inst?.operator) return [inst.operator]
    return ['apply.operator']
  }
}

/** 按表单字段值分配参与者：f_ 前缀优先 → 裸名回落 → _数字 后缀去后缀再匹配。 */
export class FormFieldAssigneeHandler implements IAssignmentHandler {
  async assign(node: FlowNode, inst: ProcessInstance | null, _operator: string): Promise<string[]> {
    if (!inst || !node) return []
    const value = this.findFieldValue(inst.variables, node.id)
    if (value == null) return []
    return this.collect(value)
  }

  /** issues/48：f_ 前缀优先 → 裸名回落 → 编号后缀去后缀匹配裸名 */
  private findFieldValue(variables: Record<string, any>, fieldName: string): any {
    if ('f_' + fieldName in variables) return variables['f_' + fieldName]
    if (fieldName in variables) return variables[fieldName]
    const m = NUMBER_SUFFIX_PATTERN.exec(fieldName)
    if (m && m[1] in variables) return variables[m[1]]
    return null
  }

  private collect(value: any): string[] {
    const ids: string[] = []
    if (Array.isArray(value)) {
      for (const item of value) this.add(ids, String(item))
    } else {
      this.add(ids, String(value))
    }
    return ids
  }

  private add(ids: string[], token: string) {
    for (const s of token.split(',')) {
      const t = s.trim()
      if (t && !ids.includes(t)) ids.push(t)
    }
  }
}

// ─── 组织维度（OrgUserProvider SPI）───────────────────────────────────────────

/** 组织维度 handler 公共依赖 */
class OrgBase {
  constructor(
    protected userProv?: UserProvider,
    protected orgProv?: OrgUserProvider,
  ) {}

  protected async byDept(deptId: string, main: boolean): Promise<string[]> {
    if (!deptId || !this.orgProv) return []
    return main ? await this.orgProv.findDeptMainLeaders(deptId) ?? [] : await this.orgProv.findDeptLeaders(deptId) ?? []
  }

  protected async deptIdOf(userId: string): Promise<string> {
    if (!userId || !this.userProv) return ''
    const u = await this.userProv.getUser(userId)
    return u?.deptId ?? ''
  }

  /** 表单字段 → 用户 id → 该用户部门 → 领导（main=true 取分管领导）。 */
  protected async byFormUser(node: FlowNode, inst: ProcessInstance | null, main: boolean): Promise<string[]> {
    if (!node || !inst) return []
    const userId = firstFormUserId(findFormUserFieldValue(inst.variables, node.id))
    if (userId === '') return []
    return this.byDept(await this.deptIdOf(userId), main)
  }
}

/** 当前用户（任务操作人）部门领导 */
export class DeptLeaderAssignmentHandler extends OrgBase implements IAssignmentHandler {
  async assign(_node: FlowNode, _inst: ProcessInstance | null, operator: string): Promise<string[]> {
    return this.byDept(await this.deptIdOf(operator), false)
  }
}

/** 当前用户（任务操作人）部门分管领导 */
export class DeptMainLeaderAssignmentHandler extends OrgBase implements IAssignmentHandler {
  async assign(_node: FlowNode, _inst: ProcessInstance | null, operator: string): Promise<string[]> {
    return this.byDept(await this.deptIdOf(operator), true)
  }
}

/** 发起人部门领导 */
export class ApplicantDeptLeaderAssignmentHandler extends OrgBase implements IAssignmentHandler {
  async assign(_node: FlowNode, inst: ProcessInstance | null, _operator: string): Promise<string[]> {
    if (!inst) return []
    return this.byDept(await this.deptIdOf(inst.operator), false)
  }
}

/** 发起人部门分管领导 */
export class ApplicantDeptMainLeaderAssignmentHandler extends OrgBase implements IAssignmentHandler {
  async assign(_node: FlowNode, inst: ProcessInstance | null, _operator: string): Promise<string[]> {
    if (!inst) return []
    return this.byDept(await this.deptIdOf(inst.operator), true)
  }
}

/** 任务节点唯一编码关联角色（roleCode = 节点 id） */
export class TaskRoleAssigneeHandler implements IAssignmentHandler {
  constructor(private orgProv?: OrgUserProvider) {}

  async assign(node: FlowNode, _inst: ProcessInstance | null, _operator: string): Promise<string[]> {
    if (!node || !this.orgProv) return []
    return await this.orgProv.findByRole(node.id) ?? []
  }
}

// ─── 表单指定用户 → 该用户所属部门领导 ───────────────────────────────────────
//
// 场景（参照 mldong-fastapi-wf 提交 fe9233d）：HR 代员工提交、代理申请——表单里给出被代理人的
// 用户 id，取**该员工**所属部门的经理／分管领导，与当前操作人无关。

/** 表单指定用户所属部门的经理 */
export class FormUserDeptLeaderAssignmentHandler extends OrgBase implements IAssignmentHandler {
  async assign(node: FlowNode, inst: ProcessInstance | null, _operator: string): Promise<string[]> {
    return this.byFormUser(node, inst, false)
  }
}

/** 表单指定用户所属部门的分管领导 */
export class FormUserDeptMainLeaderAssignmentHandler extends OrgBase implements IAssignmentHandler {
  async assign(node: FlowNode, inst: ProcessInstance | null, _operator: string): Promise<string[]> {
    return this.byFormUser(node, inst, true)
  }
}

/**
 * 两个「表单指定用户」handler 专用的四档并集查找（顺序即优先级）：
 *   1. `f_<nodeKey>`  2. `<nodeKey>`  3. 含 `#` 时取右半：先裸名、再 `f_`  4. 匹配 `_NN` 时取 base：先 `f_`、再裸名
 *
 * 与 `FormFieldAssigneeHandler.findFieldValue` 的差别只在 3、4 两档各补了 `f_` 变体
 * （参照实现没有 f_ 分支，jeeflow 家族变量存 f_ 必须有）。**现存 7 个 handler 仍走原查找。**
 */
export function findFormUserFieldValue(variables: Record<string, any> | null | undefined, nodeKey: string): any {
  if (!variables || !nodeKey) return null
  if ('f_' + nodeKey in variables) return variables['f_' + nodeKey]
  if (nodeKey in variables) return variables[nodeKey]
  const hash = nodeKey.lastIndexOf('#')
  if (hash >= 0) {
    const field = nodeKey.slice(hash + 1)
    if (field in variables) return variables[field]
    if ('f_' + field in variables) return variables['f_' + field]
  }
  const m = NUMBER_SUFFIX_PATTERN.exec(nodeKey)
  if (m) {
    if ('f_' + m[1] in variables) return variables['f_' + m[1]]
    if (m[1] in variables) return variables[m[1]]
  }
  return null
}

/**
 * 取**第一个**非空用户 id（逗号串／数组同样只取第一个，多值语义不在本轮承诺）。
 * 判空只比空串 ⇒ `'0'` 是合法 id（不被 JS 真值判据吃掉）。
 */
export function firstFormUserId(value: any): string {
  if (value === null || value === undefined) return ''
  const items = Array.isArray(value) ? value.map((v) => String(v)) : String(value).split(',')
  for (const item of items) {
    const id = item.trim()
    if (id !== '') return id
  }
  return ''
}

// ─── 表单指定部门 → 各部门负责人／分管领导（issues/258）─────────────────────────

/** 字符串按英文逗号拆；数组／Set 逐元素读取（元素不二次拆逗号）；去重保序。 */
function formDeptIds(value: any): string[] {
  if (value === null || value === undefined) return []
  try {
    const tokens: any[] = Array.isArray(value)
      ? value
      : value instanceof Set
        ? [...value]
        : String(value).split(',')
    const ids: string[] = []
    const seen = new Set<string>()
    for (const token of tokens) {
      if (token === null || token === undefined) continue
      const id = String(token).trim()
      if (id !== '' && !seen.has(id)) {
        seen.add(id)
        ids.push(id)
      }
    }
    return ids
  } catch {
    return []
  }
}

/** 两枚「表单指定部门」handler 的共用取数档；不改动 issues/254 的老 handler。 */
class FormDeptBase extends OrgBase {
  protected async byFormDept(node: FlowNode | null, inst: ProcessInstance | null, main: boolean): Promise<string[]> {
    const org = this.orgProv
    if (!node || !inst || !org) return []
    const deptIds = formDeptIds(findFormUserFieldValue(inst.variables, node.id))
    const userIds: string[] = []
    const seen = new Set<string>()
    for (const deptId of deptIds) {
      try {
        const leaders = (main ? await org.findDeptMainLeaders(deptId) : await org.findDeptLeaders(deptId)) ?? []
        if (!Array.isArray(leaders)) continue
        for (const leader of leaders) {
          if (leader === null || leader === undefined) continue
          const userId = String(leader).trim()
          if (userId !== '' && !seen.has(userId)) {
            seen.add(userId)
            userIds.push(userId)
          }
        }
      } catch {
        // 单个部门取数失败按无领导处理：结果保持为空或已收集结果，且不向引擎抛错。
      }
    }
    return userIds
  }
}

/** 表单指定 1–N 个部门，取这些部门的负责人。 */
export class FormDeptLeaderAssignmentHandler extends FormDeptBase implements IAssignmentHandler {
  async assign(node: FlowNode | null, inst: ProcessInstance | null, _operator: string): Promise<string[]> {
    return this.byFormDept(node, inst, false)
  }
}

/** 表单指定 1–N 个部门，取这些部门的分管领导。 */
export class FormDeptMainLeaderAssignmentHandler extends FormDeptBase implements IAssignmentHandler {
  async assign(node: FlowNode | null, inst: ProcessInstance | null, _operator: string): Promise<string[]> {
    return this.byFormDept(node, inst, true)
  }
}

// ─── 注册 ──────────────────────────────────────────────────────────────────────

/**
 * 注册内置通用参与者处理器到注册表（组织维度 handler 依赖 userProv/orgProv）。
 * 与 HandlerRegistry.registerAssignment 组合使用。
 */
export function registerBuiltinAssignments(
  reg: { registerAssignment(name: string, handler: IAssignmentHandler): void },
  userProv?: UserProvider,
  orgProv?: OrgUserProvider,
): void {
  reg.registerAssignment(HANDLER_OPERATOR_ASSIGNMENT, new OperatorAssignmentHandler())
  reg.registerAssignment(HANDLER_FORM_FIELD_ASSIGNEE, new FormFieldAssigneeHandler())
  reg.registerAssignment(HANDLER_DEPT_LEADER, new DeptLeaderAssignmentHandler(userProv, orgProv))
  reg.registerAssignment(HANDLER_DEPT_MAIN_LEADER, new DeptMainLeaderAssignmentHandler(userProv, orgProv))
  reg.registerAssignment(HANDLER_APPLICANT_DEPT_LEADER, new ApplicantDeptLeaderAssignmentHandler(userProv, orgProv))
  reg.registerAssignment(HANDLER_APPLICANT_DEPT_MAIN_LEADER, new ApplicantDeptMainLeaderAssignmentHandler(userProv, orgProv))
  reg.registerAssignment(HANDLER_TASK_ROLE_ASSIGNEE, new TaskRoleAssigneeHandler(orgProv))
  reg.registerAssignment(HANDLER_FORM_USER_DEPT_LEADER, new FormUserDeptLeaderAssignmentHandler(userProv, orgProv))
  reg.registerAssignment(HANDLER_FORM_USER_DEPT_MAIN_LEADER, new FormUserDeptMainLeaderAssignmentHandler(userProv, orgProv))
  reg.registerAssignment(HANDLER_FORM_DEPT_LEADER, new FormDeptLeaderAssignmentHandler(userProv, orgProv))
  reg.registerAssignment(HANDLER_FORM_DEPT_MAIN_LEADER, new FormDeptMainLeaderAssignmentHandler(userProv, orgProv))
}
