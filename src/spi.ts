import type { CcInstanceRow, DefineRow, InstanceRow, TaskRow, ProcessDefine, ProcessDesign, ProcessDesignHis, ProcessInstance, ProcessSurrogate, ProcessTask, UserInfo } from './model.js'

// 查询条件（issues/05-5：m_ 前缀参数解析产物，对齐 Java PageQuery.Condition）
export interface QueryCondition {
  column: string
  operator: string
  value: any
}

// ═══ 归属谓词基建（issues/129 案 A · 第二层「仓储兜底」）═══

/**
 * 归属谓词列：这几列定义「这条记录属于谁」，空值**绝不能**等于「不过滤」。
 * 取自门面实际下发的那四条（逐字对齐 java `JdbcProcessRepository.OWNERSHIP_COLUMNS`，
 * 本栈列名写法与 java 相同——`wf_process_task.operator` / 实例 join 出的 `pi.operator` /
 * 任务参与者表 `wf_process_task_actor.actor_id` / 抄送表 `wf_process_cc.actor_id`）：
 *   processInstance/page → t.operator、processTask/todoList → pta.actor_id、
 *   processTask/doneList → t.operator（+ pi.operator 带出的实例发起人）、processInstance/ccList → cc.actor_id
 * 口径见 jeeflow-doc `spec/06-facade.md` §2.5。
 */
export const OWNERSHIP_COLUMNS: ReadonlySet<string> = new Set([
  't.operator', 'pi.operator', 'pta.actor_id', 'cc.actor_id',
])

/** 空值判定（对齐 java `val == null || ((String) val).trim().isEmpty()`）：null/undefined/全空白串 */
export function isBlankValue(val: unknown): boolean {
  return val == null || (typeof val === 'string' && val.trim() === '')
}

/**
 * 归属谓词 + 空值 ⇒ **空页**（issues/129 案 A 第二层）。
 * 只收 `OWNERSHIP_COLUMNS` 上的 EQ 条件：动态 where 里「空值当作没填」那句是 PageQuery 对
 * `m_LIKE_*` 等**可选过滤**的通用放行，整体改掉会把可选过滤一起改坏（spec 06-facade.md §2.5 ⚠️）。
 */
export function isBlankOwnership(column: string, operator: string, val: unknown): boolean {
  return OWNERSHIP_COLUMNS.has(column) && operator.toUpperCase() === 'EQ' && isBlankValue(val)
}

/**
 * 归属证据的**有效性**判据（issues/141 G1 · 逐字对齐 java
 * `JdbcProcessRepository#hasEffectiveCondition` 的反面）：在 `isBlankValue` 的三形
 * （null / undefined / 全空白串）之上再收一档**空集合**——`[]` 表达的是「谁都没有」，
 * 与空串同档。这一档不补上，同一份数据在两仓会各说各话：内存仓 `[].trim()` 直接 TypeError，
 * SQL 仓把数组当标量绑进 `cc.actor_id = ?` 下库（既不是空页也不是报错口径统一）。
 */
export function isBlankOwnershipValue(val: unknown): boolean {
  if (isBlankValue(val)) return true
  return Array.isArray(val) && val.length === 0
}

/** 抄送归属列（`pageCcInstances` 的归属证据落在这一列上，与 OWNERSHIP_COLUMNS 里那枚同名）。 */
const CC_OWNERSHIP_COLUMN = 'cc.actor_id'

/**
 * 抄送分页的**归属条件必填**判据（issues/141 G1 · spec 06 §2.5「抄送分页同一条尺子」）。
 *
 * 本栈的归属证据有两路：门面下发的**位置参** `actorId`（java 下发的是 `cc.actor_id EQ` 条件，
 * 形状不同、义务相同）与 `conditions` 里打在 `cc.actor_id` 上的条件。判据：
 *   ① 位置参无效（缺 / 空串 / 全空白 / null / 空集合）⇒ **空页**；
 *   ② `conditions` 里凡是打在 `cc.actor_id` 上的条件，只要有一条值无效 ⇒ **空页**
 *      （含 java 那格「空 IN ⇒ 空页」；这一路不看 operator，与 java `hasEffectiveCondition` 一致）；
 *   ③ 非归属列（`m_LIKE_businessNo` 等**可选过滤**）的空值放行**不变**，仍按「没填」忽略——
 *      本判据只看 `cc.actor_id`，绝不把可选过滤一起改成空页。
 *
 * ⚠️ 两仓（`JdbcRepository` / `MemoryRepository`）**共用这一份实现**，不是各写一遍：
 * 「同一栈两个仓储两个答案」正是 issues/117 场景 27 立过法的形状，判据只留一处才不可能分叉。
 */
export function hasEffectiveCcOwnership(actorId: unknown, conditions?: QueryCondition[]): boolean {
  if (isBlankOwnershipValue(actorId)) return false
  for (const c of conditions ?? []) {
    if (c.column !== CC_OWNERSHIP_COLUMN) continue
    if (isBlankOwnershipValue(c.value)) return false
  }
  return true
}

/**
 * 归属值**单个**入参的归一值（issues/141 G10 spec 06 §2.10 ＋ issues/142 B 批 §2.11 共用的
 * **那一枚**判据）：`null`/`undefined` ⇒ 空串（即"没有归属人"）；其余取 `String(val).trim()`。
 *
 * ⚠️ 落库与比较一律用这个返回值，`" 123 "` 与 `"123"` 是同一个人——不 trim 就会与 §4 的
 * 写侧判重错开、同一人落两行。反向哨兵：判据只吃空值，`"0"` 这类"看起来像空"的正常 id
 * 归一后是 `"0"`，**不得**被丢掉。
 *
 * ⚠️ 判空一律 `String(x).trim() === ''`（即"本函数返回空串"），**严禁** `.filter(Boolean)`／
 * `if (!x)` 这类语言自带假值判据——它们会吃掉 `'0'`（spec 06 §2.11 硬要求④，php 本轮实测
 * 无回调 `array_filter` 同款）。
 */
export function normalizeActorValue(val: unknown): string {
  if (val == null) return ''
  return String(val).trim()
}

/**
 * 归属值**集合**归一（issues/141 G10「空不创建行」spec 06 §2.10 ＋ issues/142 B 批 §2.11
 * 「归属值写侧归一」共用的**那一枚**判据，对齐 java `StringUtils.normalizeCcActors`）：
 * 逐元素 {@link normalizeActorValue}，**空串 / 纯空白 / null / undefined 一律丢弃**，
 * 同一次调用内的重复折叠，顺序保持。
 *
 * <p>丢完为空时调用方的义务分两档（§2.10 要求③ ＋ §2.11 硬要求③，两档都**不新造错误码/文案**）：
 *   ① 归属值档（抄送人／加签人）：为空 ⇒ 不建行、不 fire 码 4，手动腿与"空集合"既有档同判
 *      （本栈既有文案 `'actorIds 缺失'`）；
 *   ② 主键档（`processTaskId`）：**必须响亮报错**——归属值可有可无，主键没有就是调用方写错了，
 *      静默接受会把脏数据钉进表里（本栈既有信封由 `toId()` 出 `'id 缺失或非法'`）。
 *
 * ⚠️ **单点判据**（本仓 G1 的先例：判据函数放 spi.ts，两仓共用，见 `isBlankOwnershipValue`／
 * `hasEffectiveCcOwnership`）：
 *   cc 侧——漏斗层（`engine.parseCcActors` ＋ 门面手动腿）＋ 写侧层（两仓 `createCcInstance` ＋
 *   {@link defaultCreateCcInstanceIfAbsent}）；
 *   任务侧（§2.11）——漏斗层（门面 `taskAddActor` 的 addCandidate/surrogate 两 action、`transfer`
 *   的 fromActor/toActor、`f_`／`tf_nextNodeOperator` 两腿）＋ 写侧层（两仓 `addTaskActor` 与
 *   `insertTaskActors`／`saveTask`／`updateTask` 的参与者落库腿、两仓 `updateCcStatus`）。
 * 全部走这一份实现，**严禁各抄一遍**：只修漏斗，绕过门面/引擎直连仓储的调用方照样能把空归属值
 * 灌进 `wf_process_task_actor.actor_id`／`wf_process_cc_instance.actor_id`，那正是 issues/129
 * 那族"空 operator 读全库"的病根；两份判据迟早分叉（php 本轮实测"归一函数内部严格比较、
 * 仓储写侧却用松散 in_array ⇒ `'0' == '00'` 静默丢掉第二个人"）。
 *
 * 逗号串与数组两种形态在本函数之上由 `engine.parseActorIds`（`parseCcActors` 是它的别名）收敛成
 * 同一个数组再进来，两形同判据（spec §2.10/§2.11「别只修一条腿」）。
 *
 * @param raw 归属值数组（rest 参数产物 / 已按逗号切开的元素集）；非数组按"没有归属人"处理
 */
export function normalizeActors(raw: readonly unknown[] | null | undefined): string[] {
  const out: string[] = []
  if (!Array.isArray(raw)) return out
  const seen = new Set<string>()
  for (const item of raw) {
    const actor = normalizeActorValue(item)
    // 判空只认 trim 后的空串（`'0'` 是正常 id，不是空值）；Set 用 SameValueZero，
    // 不会像松散比较那样把 `'0'` 与 `'00'` 折成一个人
    if (actor === '' || seen.has(actor)) continue
    seen.add(actor)
    out.push(actor)
  }
  return out
}

/**
 * issues/141 G10 的旧名（当时只有 cc 一支用）。issues/142 B 批按 §2.11 尾注的要求把它**升为通用**
 * 判据（任务侧 addCandidate/surrogate/transfer/nextNodeOperator/写侧两仓共用同一枚），
 * 改名会破 `@mldong/jeeflow/spi` 的既有导出面 ⇒ 采用"新增通用名 ＋ 旧名转发"：
 * 下面两枚**就是**上面那两枚（同一个函数对象、不是第二份实现），cc 支继续走同一枚。
 */
export const normalizeCcActorValue: (val: unknown) => string = normalizeActorValue
/** 同 {@link normalizeCcActorValue}：{@link normalizeActors} 的旧名转发，不是第二份判据。 */
export const normalizeCcActors: (raw: readonly unknown[] | null | undefined) => string[] = normalizeActors

/**
 * 归属值**删除腿**展开（issues/137 §3-6 · spec 06 §processTask/removeTaskActor 语义 6，
 * owner 2026-10-02 拍「两形并集」）：把待删列表展开成 `DELETE ... IN (...)` 真正要绑的值——
 * **空值一律丢弃，非空值同时保留「原值」与「trim 值」两形**（去重、保序）。
 *
 * <p>为什么必须两形、只取一头各有一种假成功（1.8.36 之前八栈正好分成这两派，没有一处两全）：</p>
 * <ul>
 *   <li>只取 **trim 值**（php/csharp/rust/moon 四栈八处的旧形状）⇒ 门面按语义 6 交出的历史脏行
 *       原值 `" 9101 "` 被削成 `9101`，真库 NO PAD 排序规则（内存仓则是列值精确比较）下那一行
 *       删不掉，门面却报成功——被摘的人待办还在；</li>
 *   <li>只取 **原值**（go/node/python/java 四栈九处的旧形状）⇒ 第三方绕过门面直连仓储传
 *       `" 8601 "` 时删不掉写侧归一后落库的规范行 `8601`（issues/142 §9.2 那一路）；且空值照喂
 *       `DELETE`，会把历史 `actor_id=''` 脏行批量误删（那是替脏数据做掉唯一痕迹）。</li>
 * </ul>
 *
 * <p>两形并集同时满足两侧：脏行按原值命中、规范行按 trim 形命中。按 §2.11 归一口径 `" 9101 "` 与
 * `9101` 本就是**同一个人**，两行都删掉才是"摘掉这个人"的正确结果，不构成误删。</p>
 *
 * <p>⚠️ trim 与判空的判据本体**只有一枚**＝{@link normalizeActorValue}（本函数只加"原值也进集合"
 * 这一层，**不抄第二份 trim/判空代码**，spec §2.11 尾注明令）：`normalizeActorValue` 把
 * `null`/`undefined`/`''`/纯空白统统归一成 `''`，所以 `trimmed === ''` 这一档就同时丢掉了空值与
 * `null`/`undefined`——**它们绝不会走到 `String(v)` 被串化成 `"null"`/`"undefined"`** 落进删除集合。
 * 判空一律 `String(x).trim() === ''`（即"归一后为空串"），**严禁** `.filter(Boolean)`／`if (!x)`
 * 这类 JS 假值判据：`"0"` 是合法 id 必须留下，且 `"0"` 与 `"00"` 是两个人。</p>
 *
 * <p>去重按**字面**做（`Array.includes`，不是"trim 后相同"折叠）：`" 9101 "` 与 `"  9101  "` 是两种
 * 不同的原值形，都要保留；SQL 仓与内存仓共用这一枚 ⇒ 同一条判据、同一个答案（issues/117 场景 27）。</p>
 *
 * @param raw 待删归属值数组，元素可为 `null`/`undefined`（丢弃，**不得**串化成 `"null"`/`"undefined"`）
 * @returns 展开后的删除值列表（保序、按字面去重、无空值）；入参为 `null`/非数组或全为空值时返回
 *          **空数组**——调用方据此**早退，一条 `DELETE` 都不发**（空数组不得退化成"清空该任务全部参与者"）
 */
export function actorDeleteForms(raw: readonly unknown[] | null | undefined): string[] {
  const out: string[] = []
  if (!Array.isArray(raw)) return out
  for (const v of raw) {
    // trim 与判空复用 normalizeActorValue 那一枚（null/undefined/''/纯空白 ⇒ ''），不抄第二份判据
    const trimmed = normalizeActorValue(v)
    if (trimmed === '') continue                        // ① 空值（含 null/undefined）一律丢弃，不喂 DELETE
    const original = String(v)                          // 此处 v 必非 null（否则 trimmed 已是 ''），绝不会得到 "null"
    if (!out.includes(original)) out.push(original)     // ② 原值形：保住未 trim 的历史脏行
    if (!out.includes(trimmed)) out.push(trimmed)       // ② trim 形：保住写侧归一后的规范行
  }
  return out
}

// ── 统计行类型（v1.8.25，issues/103）──

export interface InstanceStatsRow {
  defineId: string
  state: number
  operator: string
  createTime: Date | string | null
}

export interface TaskStatsRow {
  operator: string
  displayName: string
  performType: number
  createTime: Date | string | null
  finishTime: Date | string | null
  expireTime: Date | string | null
}

export interface ProcessRepository {
  findDefineById(id: string): Promise<ProcessDefine | null>
  // findDefineByName 按流程编码查最新一条定义（v1.1.0，Facade deploy 版本管理用）
  findDefineByName(name: string): Promise<ProcessDefine | null>
  // 定义写操作（v1.0.1，集成反馈①）：保存/更新/启停/删除流程定义
  saveDefine(define: ProcessDefine): Promise<void>
  updateDefine(define: ProcessDefine): Promise<void>
  updateDefineState(defineId: string, state: number): Promise<void>
  removeDefine(defineId: string): Promise<void>
  findInstanceById(id: string): Promise<ProcessInstance | null>
  saveInstance(inst: ProcessInstance): Promise<void>
  updateInstance(inst: ProcessInstance): Promise<void>

  findTaskById(taskId: string): Promise<ProcessTask | null>
  saveTask(task: ProcessTask): Promise<void>
  updateTask(task: ProcessTask): Promise<void>
  findDoingTasks(instanceId: string, taskNames?: string[]): Promise<ProcessTask[]>
  findDoneTasks(instanceId: string, taskNames?: string[]): Promise<ProcessTask[]>
  findHistoryTasks(instanceId: string): Promise<ProcessTask[]>

  findTaskActors(taskId: string): Promise<string[]>

  /**
   * 任务参与者的**最底层写入口**（`wf_process_task_actor.actor_id`，§2.5 口径表里的归属列）。
   *
   * <p>issues/142 B 批（spec 06 §2.11「归属值写侧归一」·owner 2026-09-30 拍「八栈一起收：
   * 两形同判据＋写侧兜底＋trim＋哨兵」）：**本成员自己就必须做归一，不能指望调用方已经归一过**——
   * 入参逐元素 {@link normalizeActorValue}（空串/纯空白/`null`/`undefined` 一律丢弃、同一次调用内的
   * 重复折叠），**落库与判重一律取 trim 后的值**（`" 123 "` 与 `"123"` 是同一个人）。判据要落在这一层
   * 而不只落在门面腿里：绕过 `processTask/addCandidate`／`processTask/surrogate`／`transfer` 直连
   * 仓储的调用方（集成层、第三方仓储消费者）同样不得把空归属值灌进 `actor_id`——空串／`"  "`／
   * `"null"`／`"<nil>"` 这一族垃圾值正是 issues/129 那族"空归属值读全库"的上游进水口。
   *
   * <p>⚠️ 反向哨兵：判空只认 `String(x).trim() === ''`，**严禁** `.filter(Boolean)`／`if (!x)`
   * 这类 JS 假值判据（会吃掉 `'0'`），也严禁松散比较（`'0' == '00'` 会把第二个人静默丢掉）。
   * <p>⚠️ SQL 仓与内存仓**必须同一判据、同一份实现**（都走 {@link normalizeActors}）——
   * 「同一栈两个仓储两个答案」是 issues/117 场景 27 立过法的形状。
   * <p>⚠️ 与主键参数分档：`taskId` 缺失/空串属**主键档**，调用方（门面 `toId()`）必须响亮报错，
   * 不得拿 `''`/`0` 当 id 落库；归属值档才允许"丢了就丢"。
   */
  addTaskActor(taskId: string, actors: string[]): Promise<void>

  /**
   * 移除任务参与者（摘人／`transfer` 摘原人／`processTask/removeTaskActor` 都落这一支）。
   *
   * <p>**归属值删除腿义务**（issues/137 §3-6 · spec 06 §processTask/removeTaskActor 语义 6，
   * owner 2026-10-02 拍「两形并集」）——**与上面 {@link addTaskActor} 的写侧义务不同，别照抄**：
   * 写侧只留 **trim 形**（落库归一、判重取 trim 后值），删除腿要「**原值 ∪ trim 值**」两形并集。</p>
   *
   * <p>三件事（八栈两仓逐处同实现）：</p>
   * <ol>
   *   <li>**空值一律丢弃、不喂 `DELETE`**：`null`／`''`／纯空白都不进 `IN`，否则历史 `actor_id=''`
   *       脏行会被批量误删（那是替脏数据做掉唯一痕迹）；</li>
   *   <li>**非空值同时以「原值」与「trim 值」两形进 `IN`**（去重、保序；两形相同则只一份）。只取
   *       trim 形 ⇒ 门面按语义 6 交出的历史脏行原值 `" 9101 "` 被削成 `9101`，真库 NO PAD 排序规则
   *       （内存仓则是列值精确比较）下那一行删不掉而门面报成功（**假成功**：被摘的人待办还在）；
   *       只取原值 ⇒ 绕过门面直连仓储的调用方传 `" 8601 "` 时删不掉写侧归一后落库的规范行 `8601`
   *       （issues/142 §9.2 那一路）。两形并集同时满足两侧，且按 §2.11 归一口径 `" 9101 "` 与 `9101`
   *       本就是同一个人，两行都删才是"摘掉这个人"的正确结果，不构成误删；</li>
   *   <li>**展开后为空 ⇒ 早退，一条 `DELETE` 都不发**——空列表不得退化成"清空该任务全部参与者"。</li>
   * </ol>
   *
   * <p>判据本体只有一枚＝{@link actorDeleteForms}（各语言栈有同名对应件），trim 与判空规则仍复用
   * {@link normalizeActorValue}／{@link normalizeActors} 那一枚，**不要在仓储里抄第二份**。判空一律
   * `String(x).trim() === ''`：`"0"` 是合法 id 必须留下，`"0"` 与 `"00"` 是两个人，**严禁**
   * `.filter(Boolean)`／`if (!x)` 这类 JS 假值判据。SQL 仓与内存仓在同一条判据上必须给同一个答案
   * （issues/117 场景 27 那把尺子）。</p>
   *
   * <p>`taskId` 仍是**主键**不是归属值，同 {@link addTaskActor} 末段那一档（缺失/空串由门面 `toId()`
   * 响亮报错，不得拿 `''`/`0` 当 id 落库）。</p>
   */
  removeTaskActor(taskId: string, actors: string[]): Promise<void>

  /**
   * 建 cc 行的**最底层写入口**（`wf_process_cc_instance`）。
   *
   * <p>issues/141 G10「空不创建行」（spec 06 §2.10）：入参里的<b>空串、纯空白、`null`/`undefined`
   * 一律丢弃</b>，落库值取 trim 后的串。判据要落在这一层而不只落在引擎漏斗里——绕过
   * `handleCcActors` 直连仓储的调用方（集成层、第三方仓储消费者）同样不得把空归属值灌进
   * `actor_id`，那正是 issues/129 那族"空 operator 读全库"的病根。实现方请复用
   * {@link normalizeActorValue}／{@link normalizeActors}（旧名 {@link normalizeCcActorValue}／
   * {@link normalizeCcActors} 是它们的别名，同一枚函数），别各写一套。</p>
   */
  createCcInstance(instanceId: string, creator: string, ...actorIds: string[]): Promise<void>

  /**
   * 抄送置已读（`wf_process_cc_instance.state` 0→1）。
   *
   * <p>issues/142 B 批（spec 06 §2.11 表第四行）：`actorId` 是归属值，**入参归一后再比**——
   * 取 {@link normalizeActorValue} 的 trim 后值做比较（否则 `" 123 "` 打不中库里的 `"123"`，
   * 已读点了没反应），且**归一后为空 ⇒ 这一支什么都不做**（空 operator 会把 `state=1`
   * 打到历史 `actor_id=''` 的脏行上）。两仓同一判据、同一份实现。</p>
   */
  updateCcStatus(instanceId: string, actorId: string): Promise<void>

  /**
   * issues/141 G2 写侧判重的**读侧**（spec 06 §4「抄送写侧判重＝幂等空操作」）：读某实例
   * **已存在**的 cc 行 actor id，供建 cc 的三条入口（发起 `f_ccActors`／办理 `tf_ccActors`／
   * 门面手动 `createCCInstance`）判重用——三条腿共用引擎那一支漏斗（§11.7）。
   *
   * <p>声明成**可选**是刻意的（java 侧对应 `IProcessRepository` 的 `default` 方法）：未实现的
   * 第三方仓储走 {@link defaultCreateCcInstanceIfAbsent} ⇒ 视作「没有既有行」⇒ 全量建行、全量 fire，
   * 与旧行为逐字一致，SPI 源码兼容不破。本包自带的两仓（`JdbcRepository` / `MemoryRepository`）
   * **必须**实现：否则 G1 那条「同一栈 SQL 仓与内存仓两个答案」的分叉在写侧重演一遍。
   */
  findCcActorIds?(instanceId: string): Promise<string[]>

  /**
   * issues/141 G2：写侧**幂等**建 cc 行。同一 `(instanceId, actorId)` 已有 cc 行时**跳过**——
   * ①不新增行 ②不重置未读状态（`state`）③不更新原行时间（`create_time`/`update_time` 逐字不变），
   * 重复抄送同一个人是数据面上的 no-op（owner 2026-09-29 明确「不需要重置」，不产生"再提醒一次"语义）；
   * 返回**实际新建**的 actor 子集（顺序与入参一致，同一次调用内的重复也折叠）。
   *
   * <p>为什么返回子集而不是 `void`：spec §11.2 原则 1「码值表达发生了什么事实」⇒ 没发生"创建"
   * 就不得 fire `CC_CREATE`（码 4）。逐人 fire 的入参一律换成这个子集，子集为空整支不 fire。
   * 查询侧不引入 DISTINCT、历史重复行也不清理（owner 拍为接受既成事实）。
   *
   * <p>未实现的仓储由 {@link defaultCreateCcInstanceIfAbsent} 兜出 java 的 `default` 语义。
   *
   * <p>issues/141 G10：入参里的空串/纯空白/null 同样先被 {@link normalizeCcActors} 丢掉，
   * 返回的子集**不可能**含空值（子集是拿去 fire 码 4 的那一份）。
   */
  createCcInstanceIfAbsent?(instanceId: string, creator: string, ...actorIds: string[]): Promise<string[]>

  // PageCcInstances 我的抄送分页（v1.3.0，对齐 Java pageCcInstances）：
  // 按抄送人 actorId 过滤实例列表，返回行数据（含关联定义名/版本）+ 总数。
  //
  // ⚠️ **归属条件必填**（issues/141 G1 · spec 06 §2.5）：`cc.actor_id` 上没有有效归属证据（缺 / 空值三形 /
  // 空集合）时必须返回**空页**（`rows=[]`、`total=0`），严禁退化成"这条不加"而返回全部实例；
  // 判据是 {@link hasEffectiveCcOwnership}，SQL 仓与内存仓共用一份实现，两仓必须同答案。
  // 非归属列的空值放行不受影响（`m_LIKE_*` 传空串仍按"没填"忽略）。
  pageCcInstances(pageNum: number, pageSize: number, actorId: string, conditions?: QueryCondition[]): Promise<{ rows: CcInstanceRow[]; total: number }>

  // ── 核心表分页（v1.5.0，对齐 Java pageDefines/pageInstances/pageTodoTasks/pageDoneTasks）──
  pageDefines(pageNum: number, pageSize: number, conditions?: QueryCondition[]): Promise<{ rows: DefineRow[]; total: number }>
  pageInstances(pageNum: number, pageSize: number, operator: string, conditions?: QueryCondition[]): Promise<{ rows: InstanceRow[]; total: number }>
  pageTodoTasks(pageNum: number, pageSize: number, actorId: string, conditions?: QueryCondition[]): Promise<{ rows: TaskRow[]; total: number }>
  pageDoneTasks(pageNum: number, pageSize: number, operator: string, conditions?: QueryCondition[]): Promise<{ rows: TaskRow[]; total: number }>

  // ── 统计查询（v1.8.25，issues/103）──
  queryInstancesForStats(stateIn?: number[] | null, start?: Date | null, end?: Date | null): Promise<InstanceStatsRow[]>
  queryTasksForStats(taskState?: number, start?: Date | null, end?: Date | null): Promise<TaskStatsRow[]>
  statsPendingAndOverdueCount(): Promise<[number, number]>
  statsCompletedTaskAggregate(): Promise<[number, number, number, number]>
  statsAvgCompletedDurationSeconds(start?: Date | null, end?: Date | null): Promise<number>
  statsDefineGroup(start?: Date | null, end?: Date | null, limit?: number): Promise<Record<string, any>[]>
  statsStuckNodeGroup(limit?: number): Promise<Record<string, any>[]>
  statsStuckApproverGroup(limit?: number): Promise<Record<string, any>[]>
  statsCompletedInstanceDurations(start?: Date | null, end?: Date | null): Promise<number[]>
}

/**
 * issues/141 G2 —— java `IProcessRepository#createCcInstanceIfAbsent` 那条 `default` 在 TS 里的对应物
 * （接口给不出默认实现，所以做成自由函数，两仓与引擎共用同一份判重逻辑）。
 *
 * 只依赖 `createCcInstance` ＋ 可选的 `findCcActorIds`，**不调用** `createCcInstanceIfAbsent`，
 * 所以自带实现的仓储可以直接 `return defaultCreateCcInstanceIfAbsent(this, …)` 而不会自我递归。
 *
 * 行为：读该实例既有 cc 行 ⇒ 折掉已存在的人与本次入参内的重复 ⇒ 只插新人 ⇒ 返回**实际新建**的子集。
 * 仓储未实现 `findCcActorIds` 时既有集合视作空 ⇒ 与旧 `createCcInstance` 全量插入逐字一致
 * （java 的 default 同理，第三方仓储不被静默改变行为）。
 *
 * <p>issues/141 G10「空不创建行」（spec 06 §2.10）：入参先过 {@link normalizeCcActors}——
 * 空串/纯空白/null 丢弃、值取 trim 后的串，所以**返回的子集里没有空值**（子集是拿去 fire 码 4 的
 * 那一份），全空入参 ⇒ `fresh` 为空 ⇒ 连 `createCcInstance` 都不调用。本函数是 java 那条 `default`
 * 的对应物，也是"写侧兜底"这一层：漏斗修好了、绕过引擎直连仓储的调用方仍在这里被同一判据挡住。
 */
export async function defaultCreateCcInstanceIfAbsent(
  repo: Pick<ProcessRepository, 'createCcInstance' | 'findCcActorIds'>,
  instanceId: string,
  creator: string,
  actorIds: string[],
): Promise<string[]> {
  const existing = repo.findCcActorIds ? await repo.findCcActorIds(instanceId) : []
  // issues/141 G10：先归一（空值丢弃＋trim＋同次折叠），再与既有行判重——与 G2 同一条尺子
  const fresh: string[] = []
  for (const actorId of normalizeCcActors(actorIds)) {
    if (existing.includes(actorId) || fresh.includes(actorId)) continue
    fresh.push(actorId)
  }
  if (fresh.length > 0) await repo.createCcInstance(instanceId, creator, ...fresh)
  return fresh
}

export interface UserProvider {
  getUser(userId: string): Promise<UserInfo | null>
}

export interface OrgUserProvider {
  /** 部门领导（deptId → 领导 userId 列表） */
  findDeptLeaders(deptId: string): Promise<string[]>
  /** 部门分管领导（deptId → 分管领导 userId 列表） */
  findDeptMainLeaders(deptId: string): Promise<string[]>
  /** 按角色取人（roleCode → userId 列表） */
  findByRole(roleCode: string): Promise<string[]>
}

export interface IDGenerator {
  nextId(): string
}

export interface ExpressionEvaluator {
  eval(expr: string, vars: Record<string, any>): Promise<any>
}

// ── 扩展仓储 SPI（v1.1.0，可选）——流程设计 / 设计历史 / 委托代理 ──

export interface ProcessExtRepository {
  // 流程设计（wf_process_design）
  findDesignById(id: string): Promise<ProcessDesign | null>
  saveDesign(d: ProcessDesign): Promise<void>
  updateDesign(d: ProcessDesign): Promise<void>
  removeDesign(id: string): Promise<void>
  pageDesigns(pageNum?: number, pageSize?: number, filters?: Record<string, any>, conditions?: QueryCondition[]): Promise<[ProcessDesign[], number]>

  // 设计历史（wf_process_design_his）
  saveDesignHis(his: ProcessDesignHis): Promise<void>
  listDesignHis(designId: string): Promise<ProcessDesignHis[]>

  // 委托代理（wf_process_surrogate）
  findSurrogateById(id: string): Promise<ProcessSurrogate | null>
  saveSurrogate(s: ProcessSurrogate): Promise<void>
  updateSurrogate(s: ProcessSurrogate): Promise<void>
  removeSurrogate(id: string): Promise<void>
  pageSurrogates(pageNum?: number, pageSize?: number, filters?: Record<string, any>, conditions?: QueryCondition[]): Promise<[ProcessSurrogate[], number]>

  // getSurrogate 查询指定时间生效中的委托（06 §4.5 条款 1.4 + issues/123）：**先**按主键 id
  // 取该流程作用域内**最新一条**（不带生效判据过滤），**再**由四判据裁决这一条
  // （enabled 只认**数值** 1 / 自委托过滤 / 时间窗任一侧空=不限，at 为空则不比较窗口）。
  // issues/130 案 A：判据不吃串，所以整数列被驱动字符串化（回读成 '1'）必须在**实现侧**交判据前
  // 还原（内置 SQL 仓走 surrogateHydrateEnabled；自定义 SPI 仓储不还原则按停用处理）；
  // '1.0' / ' 1' / 'abc' / true / 0 / 2 / null 一律不生效，不得顺手放宽成 Number(v)===1。
  // 该作用域无记录才兜底 processName 为空的"全流程委托"；最新一条不生效 ⇒ null，
  // 同层内不回落更旧那条，但精确作用域判否后仍要看全流程作用域（条款 1.4 后半句）。见 src/surrogate-rule.ts。
  getSurrogate(operator: string, processName: string, at?: Date): Promise<ProcessSurrogate | null>
}
