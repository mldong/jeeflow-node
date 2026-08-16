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
}
