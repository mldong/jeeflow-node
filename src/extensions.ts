import type { FlowNode, ProcessInstance } from './model.js'

/** 流程拦截器——对标 Java FlowInterceptor */
export interface FlowInterceptor {
  preHandle(node: FlowNode, inst: ProcessInstance): boolean | Promise<boolean>
  postHandle(node: FlowNode, inst: ProcessInstance): void | Promise<void>
  order: number
}

/**
 * 动态参与者指派——对标 Java AssignmentHandler.assign
 * @param handlerName 节点配置的 assignmentHandler 名（如 "com.xxx.MyHandler"）
 * @returns 参与者 ID 列表（空数组表示不处理）
 */
export type AssignmentHandler = (handlerName: string, node: FlowNode, inst: ProcessInstance) => string[] | Promise<string[]>

/**
 * 自定义决策处理器——对标 Java DecisionHandler
 * @param handlerName 节点配置的 decisionHandler 名
 * @returns 选中的分支边 ID（空字符串表示不处理）
 */
export type DecisionHandler = (handlerName: string, node: FlowNode, inst: ProcessInstance, vars: Record<string, any>) => string | Promise<string>

/**
 * 流程事件类型 —— **规范 11 §11.3「A 套整型码表」**（issues/132 整表重排 ＋ issues/127 补 5/6/7/8/9）。
 *
 * ⚠️ 破坏性变更（spec §11.6 明写）：本栈旧形状是 `iota` 起的 0..5 套
 * （ProcessStart=0 / ProcessFinish=1 / ProcessReject=2 / TaskCreate=3 / TaskComplete=4 / CcCreate=5），
 * 现整表重排到 A 套 1..9，与 Java/PHP/Rust/MoonBit/C# 同套：
 *   - CcCreate 5 → 4（4 号位由 Java 让出的死码 PROCESS_TASK_END 腾出，与 PHP v1.3.8 活码对齐）
 *   - TaskComplete 4 → 5
 *   - 旧 ProcessFinish(1) 与 ProcessReject(2) **合并**为 ProcessInstanceEnd(2)——办结/拒绝/撤回/终止
 *     共用一支，靠载荷 `state` 分；"任务被退回"另立 TaskReject(6)，不再混在实例终态里
 *   - TaskCreate → ProcessTaskStart（规范名）、ProcessStart → ProcessInstanceStart
 *
 * **规范名是权威，码值只是各栈内部的附带数值**（§11.3 首段）：集成层跨语言判据一律按规范名分派，
 * 不得拿数字码当判据（旧版已发布版本里数字码不可混用）。10+ 号段为超时催办/超时自动通过预留，
 * 本轮不发（§11.4 第 1 条：八栈都无时钟扫描器，发了没有触发源）。
 *
 * 旧成员名（`ProcessStart`/`ProcessFinish`/`ProcessReject`/`TaskCreate`/`TaskComplete`/`CcCreate`）
 * 按 §11.6「改名兼容义务」**保留一代**——别名在本 enum **外部**，见下方常量块（为什么不能写进来）。
 */
export enum EventType {
  /** 1 · 实例发起成功——实例行 `insert` 之后 fire */
  ProcessInstanceStart = 1,
  /** 2 · 实例进入终态——`state` 落库为 20/30/40/45/50/99 之后 fire，载荷带落库后的 `state` */
  ProcessInstanceEnd   = 2,
  /** 3 · 新待办生成——每个任务行落库（分到 taskId）之后逐任务 fire，载荷带 `actors` */
  ProcessTaskStart     = 3,
  /** 4 · 新增一条抄送记录——cc 行落库之后**逐抄送人** fire（发起 f_ccActors／办理 tf_ccActors／手动 createCCInstance 三条路径同判） */
  CcCreate             = 4,
  /** 5 · 任务被办掉（同意/跳转/会签办理）——任务行 state 更新为已完成并落库之后；与 6 互斥 */
  TaskComplete         = 5,
  /** 6 · 任务被退回/拒绝（含退发起人、软拒绝、跳转回退）——退回动作使任务/实例落库之后；与 5 互斥 */
  TaskReject           = 6,
  /** 7 · 转办发生——任务参与者被替换并落库之后 */
  TaskTransfer         = 7,
  /** 8 · 撤回发生——撤回把实例 state 写 30 落库、被撤回任务行更新完成后 fire **一次**（不逐任务） */
  TaskWithdraw         = 8,
  /** 9 · 实例被终止——实例 state 写 40 落库之后（本栈当前无写 40 的门面动作，见 engine.notifyInstanceEnd） */
  InstanceTerminated   = 9,
}

/**
 * 旧成员名兼容别名 —— 规范 11 §11.6「改名兼容义务（八栈统一）」：成员改名时必须**保留旧成员名作为
 * 同符号别名一代**并打 deprecate 注释，下一个代次再删。别名保的是"源码还能编过、switch 还能命中同一支"，
 * **不保数值**——本轮整表重排后旧码值已挪位，每条注释按「旧码 → 新码」标注（go 的
 * `EventProcessStart = EventProcessInstanceStart` 即同形状；python 靠枚举成员别名做到"别名不参与
 * list(EventType)"，TS 数字枚举没有这个对应物，见下）。
 *
 * ⚠️ **TS 专有的坑（务必不要"顺手改优雅"）**：这些别名必须写在 enum **外部**，绝不能写成 `enum`
 * 的成员（`enum EventType { ProcessStart = 1, ProcessInstanceStart = 1, … }`）。数字枚举会为
 * **每个**成员生成反向映射 `E[E["X"]=1]="X"`，同值的后声明成员会**覆盖** `E[1]` —— `EventType[1]`
 * 就从 `'ProcessInstanceStart'` 变成 `'ProcessStart'`。集成层/L2-30 的事件流水 sink 靠 code→规范名
 * 映射写 `<code>|<规范名>|<sourceId>`，反向映射被污染＝线上假红。写成模块级常量则完全不进 `EventType`
 * 对象：1..9 的反向映射与 `Object.keys(EventType)` 保持九支纯净（`__tests__/spec.test.ts` 的
 * 「反向映射未被别名污染」格钉这条），别名只是同名同值的导出常量。
 *
 * 集成壳本轮一律**改用规范名**，不依赖别名续命（§11.6 末段）——别名只留给外部消费者一个代次的迁移窗口。
 * §11.6 的"一代"窗口到期后，本块六条别名连同注释一并删除。
 */

/** @deprecated 旧名（码 0）→ 规范名 `EventType.ProcessInstanceStart`（码 1）：同一支，仅码值挪位。一代后删。 */
export const ProcessStart  = EventType.ProcessInstanceStart
/** @deprecated 旧名（码 1）→ 规范名 `EventType.ProcessInstanceEnd`（码 2）：旧"办结"并入"实例终态"，靠载荷 `state` 分。一代后删。 */
export const ProcessFinish = EventType.ProcessInstanceEnd
/** @deprecated 旧名（码 2）→ 规范名 `EventType.ProcessInstanceEnd`（码 2）：与 `ProcessFinish` **合并为同一支**（同码同物）；"任务被退回"另立 `EventType.TaskReject`(6)。一代后删。 */
export const ProcessReject = EventType.ProcessInstanceEnd
/** @deprecated 旧名（码 3）→ 规范名 `EventType.ProcessTaskStart`（码 3）：名改码不改。一代后删。 */
export const TaskCreate    = EventType.ProcessTaskStart
/** @deprecated 旧名（码 4）→ 成员名沿用规范名 `EventType.TaskComplete`，但码值 4→5 挪位。此处导出的是"裸名"通道（`import { TaskComplete }`），一代后删。 */
export const TaskComplete  = EventType.TaskComplete
/** @deprecated 旧名（码 5）→ 成员名沿用规范名 `EventType.CcCreate`，但码值 5→4 挪位。同上，"裸名"通道，一代后删。 */
export const CcCreate      = EventType.CcCreate

/**
 * 流程事件载荷（§11.3「直传载荷键」）。本栈用扁平键承载（Java 是 `ProcessEvent{eventType, sourceId,
 * ccActorId, data}` 的 map 形状，§11.3 允许各栈自定承载形态，但**必备键必须拿得到**，键名 camelCase）。
 *
 * ⚠️ issues/122 同族坑：可空字段**不要用"省略整键"表达**。某支事件的必备键在 fire 点必须赋实际值
 * （整数就出整数、字符串就出字符串），不得留 undefined ——undefined 经 JSON 序列化即整键消失，
 * 与 NestJS 全局 SmartNullStripping 剥 null 键是同一个病。不适用某键的事件型别省它，直接不传即可。
 */
export interface ProcessEvent {
  type: EventType
  instanceId: string
  taskId?: string
  nodeId?: string
  operator: string
  /** 抄送人 id 直传事件体，监听器免反查 cc 表（issues/102；对齐 Java ccActorId / Go CcActorID） */
  ccActorId?: string
  /** code 2 · 落库后的实例状态整数（InstanceState：20/30/40/45/50/99） */
  state?: number
  /** code 3 · 该待办的参与者列表（含并入的代理人） */
  actors?: string[]
  /** code 5 / 6 · 本次提交的 submitType（§11.2 原则 2「码粗、载荷细」：拒绝/跳转/退发起人靠它区分） */
  submitType?: number
  /** code 7 · 被摘走的原参与人 */
  fromActor?: string
  /** code 7 · 接手的新参与人 */
  toActor?: string
  /** code 9 · 终止原因（无原因出空串，不省键） */
  reason?: string
}

export type ProcessEventListener = (event: ProcessEvent) => void | Promise<void>

export interface EngineExtensions {
  interceptors?: FlowInterceptor[]
  /** 定义级拦截器注册表（issue 34）：名字 → 实例；流程定义顶层 postInterceptors 按名解析 */
  interceptorRegistry?: Record<string, FlowInterceptor>
  assignmentHandler?: AssignmentHandler
  decisionHandler?: DecisionHandler
  listeners?: ProcessEventListener[]
}
