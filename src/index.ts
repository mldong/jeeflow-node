export { EngineImpl, type Engine, type EngineOptions, type SurrogateLookup } from './engine.js'
export { MemoryRepository } from './memory.js'
export { MemoryExtRepository } from './memory-ext.js'
export { HandlerRegistry, type IAssignmentHandler, type IDecisionHandler, type HandlerMeta, type HandlerType } from './registry.js'
export { enumDict, enumDictKeys, type DictItem } from './metadata.js'
export * from './model.js'
export type { ProcessRepository, ProcessExtRepository, UserProvider, OrgUserProvider, IDGenerator, ExpressionEvaluator, QueryCondition } from './spi.js'
export {
  SqliteDynamicTableWriter,
  PersistPostInterceptor,
  registerPersistMeta,
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
// issues/132 §11.3：码表重排后 EventType 必须能从包门面 value-import——
// `./extensions` 子路径不在 exports map 里（集成层此前只能在自己仓镜像一份数字码，
// nestjs 壳 wf-message.listener.spec.ts 就是这么写的），拿规范名分派的契约要求
// 得有一个公开入口，否则下一栈又会发明第四套码值。
// §11.6 改名兼容义务：六个旧成员名的别名走**同一条出口**（外部第三方 import 面只有本门面），
// 别名是 enum 外部的同值常量（详见 extensions.ts 的反向映射坑注释），一代后随源码一并删除。
export { EventType,
  ProcessStart, ProcessFinish, ProcessReject, TaskCreate, TaskComplete, CcCreate,
} from './extensions.js'
export type { EngineExtensions, FlowInterceptor, ProcessEventListener, ProcessEvent,
  AssignmentHandler, DecisionHandler } from './extensions.js'
export { JdbcProcessExtRepository } from './jdbc/ext.js'
