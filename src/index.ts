export { EngineImpl, type Engine } from './engine.js'
export { MemoryRepository } from './memory.js'
export { HandlerRegistry, type IAssignmentHandler, type IDecisionHandler, type HandlerMeta } from './registry.js'
export { enumDict, enumDictKeys, type DictItem } from './metadata.js'
export * from './model.js'
export type { ProcessRepository, UserProvider, OrgUserProvider, IDGenerator, ExpressionEvaluator } from './spi.js'
export {
  SqliteDynamicTableWriter,
  PersistPostInterceptor,
  type DynamicTableWriter,
  type DefineLoader,
} from './persist.js'
export {
  registerBuiltinAssignments,
  OperatorAssignmentHandler,
  FormFieldAssigneeHandler,
  DeptLeaderAssignmentHandler,
  DeptMainLeaderAssignmentHandler,
  ApplicantDeptLeaderAssignmentHandler,
  ApplicantDeptMainLeaderAssignmentHandler,
  TaskRoleAssigneeHandler,
  HANDLER_OPERATOR_ASSIGNMENT,
  HANDLER_FORM_FIELD_ASSIGNEE,
  HANDLER_DEPT_LEADER,
  HANDLER_DEPT_MAIN_LEADER,
  HANDLER_APPLICANT_DEPT_LEADER,
  HANDLER_APPLICANT_DEPT_MAIN_LEADER,
  HANDLER_TASK_ROLE_ASSIGNEE,
} from './builtin.js'

// issues/35：包导出面补齐——门面/扩展类型/扩展仓储（集成方组装完整引擎链）
export { JeeflowFacade } from './facade.js'
export type { EngineExtensions, FlowInterceptor, ProcessEventListener, ProcessEvent,
  AssignmentHandler, DecisionHandler } from './extensions.js'
export { JdbcProcessExtRepository } from './jdbc/ext.js'
