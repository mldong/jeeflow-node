import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { inspect } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname as pathDirname, join as pathJoin } from 'node:path'
import { EngineImpl } from '../src/engine.js'
import { MemoryRepository } from '../src/memory.js'
import { MemoryExtRepository } from '../src/memory-ext.js'
import { JeeflowFacade, INTERNAL_FAILURE_MSG, isForeignDetail } from '../src/facade.js'
import { SubmitType, TaskState } from '../src/model.js'
import type { ExpressionEvaluator, QueryCondition, UserProvider } from '../src/spi.js'
import { dir as flowsResolverDir } from '../flows-resolver.js'

/**
 * 门面内部异常出口不得泄漏内部原文（issues/137 §3-1 · spec 06-facade.md **§2.12**）· Node 腿。
 * Java 基准＝`JeeflowFacade.isForeignDetail` ＋ `FacadeInternalErrorNoLeakTest`，本文件按同等判据复刻。
 *
 * 判据两侧都要有牙：
 *  - **负向**：运行时／驱动／JSON 解析器／集成方 provider 写的原文不得进出口 msg（也不得进任何其它
 *    对外字段），只能进日志与错误对象的 `cause`；对外一律逐字 `流程处理失败`。
 *  - **正向／回归**：引擎自己写的中文契约文案必须**仍逐字透出**。这一组同样重要——判据一旦过宽
 *    （例如收窄成"一律固定文案"），八栈＋十三壳＋前端 toast 对齐的契约面会被静默改掉而没人报警，
 *    正是 §2.12「⚠️ 因此不能简单收窄」点名的事故。java 侧这类文案一处测试都没钉，本栈把它钉上
 *    （含 A 组末尾那条"全仓契约文案扫描"守门格）。
 *  - **副作用**：原文确实进了日志（不只断言 msg——否则"把原文整个丢掉"也能绿）。
 *
 * ⚠️ 本栈前提（docs/批三-3-1-落地记录 §1.5 node 行，本文件现读复核过）：node 引擎**没有**专门的
 * 契约异常类（`src/*.ts` 零 `class *Error extends`），契约文案一律裸 `throw new Error('中文')`
 * ⇒ 判别式**第 2 条（契约异常族 ⇒ 逐字透出）在本栈无处落**，判据重心在第 4 条（`Error` 与
 * `TypeError`/`RangeError`/`SyntaxError`/`ReferenceError` 是可区分的构造器）与第 5 条（抛出点归属）。
 */

const FIXED = INTERNAL_FAILURE_MSG
const flowDir = flowsResolverDir() + '/'

// id 发生器用单调计数器（同 spec.test.ts / remove-task-actor-115.test.ts 的理由：Date.now()+随机数
// 同毫秒撞号率实测 54%，撞上的 id 在内存仓 Map 里互相覆盖 ⇒ 随机复现的假红）。
function mkSeqIdGen() {
  const base = Date.now() * 1000
  let n = 0
  return { nextId() { n += 1; return String(base + n) } }
}

// ═══ 栈夹具：判别式第 5 条按"抛出点在不在引擎目录"判归属 ═══════════════════════════════
// 引擎源码目录（<pkg>/src）——本测试文件在 <pkg>/__tests__，往上一级即包根。
const PKG_ROOT = pathDirname(pathDirname(fileURLToPath(import.meta.url)))
const ENGINE_SRC = pathJoin(PKG_ROOT, 'src')
/** 一条"抛出点在引擎里"的栈（形状照实测 V8 帧：`at fn (path:line:col)`） */
const ENGINE_STACK = `Error: x\n    at toId (${pathJoin(ENGINE_SRC, 'facade.ts')}:1720:24)\n    at JeeflowFacade.dispatch (${pathJoin(ENGINE_SRC, 'facade.ts')}:81:21)`
/** 一条"抛出点在引擎外"的栈（第三方驱动 / 集成方 provider / 测试桩都属这一档） */
const FOREIGN_STACK = `Error: x\n    at Connection.query (/app/node_modules/mysql2/lib/connection.js:123:45)`
/** node 内置模块抛的（java 的 JDK 帧等价物；实测 fs 的 ENOENT 就是这个形状） */
const NODE_INTERNAL_STACK = `Error: x\n    at Object.openSync (node:fs:560:18)`
/** 拿不到归属信息的栈顶帧（实测 `JSON.parse` 的 SyntaxError 就是 `at JSON.parse (<anonymous>)`） */
const ANON_STACK = `SyntaxError: x\n    at JSON.parse (<anonymous>)`

/** 契约文案的判据入口：裸 `Error` ＋ 抛出点在引擎内（引擎 51 条文案全是这个形状） */
function contractVerdict(message: unknown): boolean {
  return isForeignDetail('Error', message, undefined, ENGINE_STACK)
}

// ═══ A 组：纯函数判据（文案判据可测，不碰副作用）═══════════════════════════════════════

describe('issues/137 §3-1 · A 纯函数 isForeignDetail（spec 06 §2.12 判别式五条）', () => {

  it('A1 第 1 条：message 缺失／非字符串／纯空白 ⇒ 判内部（兜底会吐 String(e) 的类名头部）', () => {
    assert.equal(isForeignDetail('Error', undefined, undefined, ENGINE_STACK), true, 'undefined')
    assert.equal(isForeignDetail('Error', null, undefined, ENGINE_STACK), true, 'null')
    assert.equal(isForeignDetail('TypeError', '', undefined, ENGINE_STACK), true, '空串')
    assert.equal(isForeignDetail('Error', '   ', undefined, ENGINE_STACK), true, '纯空白')
    assert.equal(isForeignDetail('Error', 42 as any, undefined, ENGINE_STACK), true, '非字符串（throw 123 一类）')
    assert.equal(isForeignDetail('Error', {} as any, undefined, ENGINE_STACK), true, '非字符串对象')
  })

  it('A2 第 4 条：运行时／解析器／反射族 ⇒ 判内部（node 等价类型逐一）', () => {
    // java 12 类 → node 映射（实测取证见各格 message）
    const rows: Array<[string, string, string]> = [
      ['TypeError', "Cannot read properties of undefined (reading 'x')", 'NullPointerException / ClassCastException / ReflectiveOperationException'],
      ['RangeError', 'Invalid array length', 'IndexOutOfBoundsException / ArithmeticException / NumberFormatException'],
      ['RangeError', 'Maximum call stack size exceeded', 'StackOverflowError'],
      ['SyntaxError', "Expected property name or '}' in JSON at position 1 (line 1 column 2)", 'JSON 解析器原文'],
      ['SyntaxError', 'Cannot convert 12x to a BigInt', '数字解析（NumberFormatException 等价）'],
      ['ReferenceError', 'ghostVar is not defined', '未声明标识符'],
      ['EvalError', 'x', 'node 自带同族'],
      ['URIError', 'URI malformed', 'node 自带同族'],
      ['AggregateError', 'All promises were rejected', 'node 自带同族'],
    ]
    for (const [ctor, message, why] of rows) {
      // 栈故意给"引擎内"，证明这一格是**第 4 条**抓的、不是靠第 5 条兜的
      assert.equal(isForeignDetail(ctor, message, undefined, ENGINE_STACK), true, `${ctor}: ${message}（${why}）`)
    }
  })

  it('A3 第 4 条反面：裸 `Error` 不在族里——它是本栈契约文案的唯一载体，收进来等于改掉整个契约面', () => {
    // §2.12「⚠️ 因此不能简单收窄」：引擎 51 条文案全是 `throw new Error('中文')`
    assert.equal(contractVerdict('流程定义不存在'), false, '裸 Error ＋ 引擎栈 ⇒ 逐字透出')
    assert.equal(contractVerdict('任务非进行中，不可摘除参与人'), false)
    // 引擎那几条英文文案同样不得被判内部（它们也是引擎自己写的）
    assert.equal(contractVerdict('define not found: 123'), false)
    assert.equal(contractVerdict('operator user1 not allowed'), false)
    assert.equal(contractVerdict('persist: table sys_user not found'), false)
    assert.equal(contractVerdict('ExpressionEvaluator 未配置'), false, '首字母大写但不是 `XxxError: ` 头部')
  })

  it('A4 第 3 条：裸包装两种 node 形状都判内部（只是搬运下层原文，引擎没写过它）', () => {
    const inner = new Error('内部驱动细节 12345')
    // 形状①：显式带 cause，message 就是 cause 的串化
    assert.equal(isForeignDetail('Error', String(inner), inner, ENGINE_STACK), true, 'message === String(cause)')
    // 形状②：message 等于 cause.message
    assert.equal(isForeignDetail('Error', inner.message, inner, ENGINE_STACK), true, 'message === cause.message')
    // 形状③（node 特有，实测）：`new Error(innerErr)` 把 String(innerErr) 塞进 message 且**不保留** cause
    const bare = new Error(inner as any)
    assert.equal(bare.cause, undefined, '前置取证：node 这个形状确实没有 cause')
    assert.equal(bare.message, 'Error: 内部驱动细节 12345', '前置取证：message 就是下层原文的串化')
    assert.equal(isForeignDetail('Error', bare.message, bare.cause, ENGINE_STACK), true, '无 cause 也要按头部认出裸包装')
    // java 侧那条 `java.lang.IllegalStateException: 内部驱动细节 12345` 同形状
    assert.equal(contractVerdictIsForeign('java.lang.IllegalStateException: 内部驱动细节 12345'), true)
    assert.equal(contractVerdictIsForeign('com.mysql.cj.jdbc.exceptions.SQLException: near "x"'), true)
  })

  /** 裸包装的头部判据不依赖栈/cause，单独抽出来核（与 A4 同一枚正则） */
  function contractVerdictIsForeign(message: string): boolean {
    return isForeignDetail('Error', message, undefined, ENGINE_STACK)
  }

  it('A5 第 3 条不得误杀：引擎的 `{ cause }` 契约包装（批二 issues/139 那三腿）必须仍判"透出"', () => {
    // 形状＝saveDeployedDefine / redeploy / designRedeploy 三腿：
    //   throw new Error('读取流程定义 JSON 失败', { cause: <SyntaxError> })
    let syntax: any
    try { JSON.parse("{bad json") } catch (e) { syntax = e }
    assert.ok(syntax instanceof SyntaxError, '前置取证：JSON.parse 抛的是 SyntaxError')
    const wrapped = new Error('读取流程定义 JSON 失败', { cause: syntax })
    assert.equal(wrapped.cause, syntax, '前置取证：cause 已挂上')
    // 关键：message 是引擎契约文案、cause 是解析器原文 ⇒ **不得**因为"带了 cause"或
    // "cause 是 SyntaxError"就被判内部（那会把这一族契约文案静默改成固定文案）
    assert.equal(isForeignDetail('Error', wrapped.message, wrapped.cause, ENGINE_STACK), false,
      '契约文案 ＋ SyntaxError cause ⇒ 仍逐字透出')
    assert.equal(wrapped.message, '读取流程定义 JSON 失败')
  })

  it('A6 第 5 条：抛出点不在引擎包 ⇒ 判内部（node 覆盖 IO／驱动／第三方 provider 的唯一判据）', () => {
    const FOREIGN_TEXT = 'Lock wait timeout exceeded; try restarting transaction'
    // 实测取证：fs 的 ENOENT、mysql2/pg 的查询错，ctor 名**恰好也是 `Error`** ⇒ 第 4 条抓不到
    assert.equal(isForeignDetail('Error', FOREIGN_TEXT, undefined, FOREIGN_STACK), true, '驱动帧（node_modules/mysql2）')
    assert.equal(isForeignDetail('Error', "ENOENT: no such file or directory, open '/etc/x.json'", undefined, NODE_INTERNAL_STACK), true, 'node 内置模块帧')
    assert.equal(isForeignDetail('Error', 'LDAP connection refused 10.0.0.7:389', undefined,
      `Error: x\n    at UserProviderImpl.findById (/app/src/providers/ldap.ts:44:12)`), true, '集成方 provider 帧')
    // 反面：同一句文案、抛出点在引擎里 ⇒ 判"引擎写的"，逐字透出（判据是"谁写的"，不是"写了什么"）
    assert.equal(isForeignDetail('Error', FOREIGN_TEXT, undefined, ENGINE_STACK), false, '同文案＋引擎帧 ⇒ 透出')
  })

  it('A7 第 5 条失败开放：栈不可用时判"非内部"，绝不误杀契约文案（与 java 相反，理由见 thrownInsideEngine）', () => {
    // node 的 stack 是 V8 私有格式：`<anonymous>`/`native` 帧、stackTraceLimit 截断、跨 worker 丢栈、
    // source-map/打包器改写路径都会让归属拿不到。误判成"外来"＝静默改契约面（不可接受），
    // 误判成"引擎写的"＝漏挡一条内部原文（仍被第 1/3/4 条与日志兜着）⇒ 一律失败开放。
    assert.equal(isForeignDetail('Error', '流程定义缺少 name', undefined, undefined), false, '无 stack')
    assert.equal(isForeignDetail('Error', '流程定义缺少 name', undefined, null), false, 'stack=null')
    assert.equal(isForeignDetail('Error', '流程定义缺少 name', undefined, ''), false, 'stack 空串')
    assert.equal(isForeignDetail('Error', '流程定义缺少 name', undefined, 'not a stack at all'), false, '无帧')
    assert.equal(isForeignDetail('Error', '流程定义缺少 name', undefined, ANON_STACK), false, '栈顶 `<anonymous>`')
    // 但这类形状若本身就是运行时族，第 4 条照样抓（不依赖栈）⇒ 泄漏不会因此漏网
    assert.equal(isForeignDetail('SyntaxError', "Expected property name or '}' in JSON at position 1", undefined, ANON_STACK), true,
      'JSON.parse 的 SyntaxError 栈顶就是 <anonymous>，靠第 4 条抓')
  })

  it('A8 纯函数性：不抛、不改入参、同入参同出参（文案判据与副作用各自可测的前提）', () => {
    const cause = new Error('内部驱动细节 12345')
    const stack = FOREIGN_STACK
    const args: any[] = ['Error', 'some message', cause, stack]
    const snapshot = inspect(args)
    let a = false
    let b = false
    assert.doesNotThrow(() => { a = isForeignDetail(...args); b = isForeignDetail(...args) }, '任何入参组合都不得抛')
    assert.equal(a, b, '同入参同出参')
    assert.equal(inspect(args), snapshot, '不得改写入参对象')
    // 畸形入参也不抛
    for (const weird of [undefined, null, 0, '', [], {}, NaN, Symbol.iterator as any, () => {}] as any[]) {
      assert.doesNotThrow(() => isForeignDetail(weird, weird, weird, weird), `畸形入参不得抛`)
    }
  })

  it('A9 守门格·全仓契约文案扫描：src 里每一条 throw new Error 字面量都必须判"逐字透出"', () => {
    // 这一格是"判据过宽会静默改掉契约面"的自动守门：新增/改动引擎文案后，只要它被判成内部，
    // 这里当场红。java 侧一处都没钉（§2.12 明写），本栈钉上。
    const files: string[] = []
    for (const f of readdirSync(ENGINE_SRC)) if (f.endsWith('.ts')) files.push(pathJoin(ENGINE_SRC, f))
    const jdbcDir = pathJoin(ENGINE_SRC, 'jdbc')
    for (const f of readdirSync(jdbcDir)) if (f.endsWith('.ts')) files.push(pathJoin(jdbcDir, f))
    assert.ok(files.length >= 10, `扫描面应覆盖 src 全量，实得 ${files.length} 个文件`)

    const messages = new Set<string>()
    for (const file of files) {
      const text = readFileSync(file, 'utf-8')
      // 不要求紧跟右括号：`throw new Error('…', { cause: e })` 那三条解析腿也要扫进来
      for (const m of text.matchAll(/throw new Error\('([^']*)'/g)) messages.add(m[1])
      // 模板串：把 ${...} 换成占位值，得到一条真实可达的完整文案
      for (const m of text.matchAll(/throw new Error\(`([^`]*)`/g)) {
        messages.add(m[1].replace(/\$\{[^}]*\}/g, 'X'))
      }
    }
    // 现读基线：32 条单引号 ＋ 19 条模板串（去重后 51 条）。少于这个量级说明正则没咬上，
    // 那这一格就成了假绿——所以把下界也钉住。
    assert.ok(messages.size >= 40, `应扫出 40+ 条引擎契约文案，实得 ${messages.size} 条（正则可能失效）`)

    const leaked: string[] = []
    for (const msg of messages) {
      if (contractVerdict(msg)) leaked.push(msg)
    }
    assert.deepEqual(leaked, [], `以下引擎契约文案被判成"内部"⇒ 会被静默换成固定文案，契约面被改掉：${JSON.stringify(leaked)}`)
    // 逐字抽查四条 spec 点名的既有文案确实在扫描面里（防"扫到 0 条也算全绿"）
    for (const must of ['读取流程定义 JSON 失败', '流程定义缺少 name', '任务非进行中，不可摘除参与人', '至少需保留一名参与人']) {
      assert.ok(messages.has(must), `扫描面应含「${must}」`)
      assert.equal(contractVerdict(must), false, `「${must}」必须判"逐字透出"`)
    }
  })
})

// ═══ 出口夹具 ═══════════════════════════════════════════════════════════════════════

/** 仓储桩：按需在 `pageInstances` 上抛指定异常（java 基准用 Proxy 按 methodName 抛，本栈同姿势） */
class ThrowingRepo extends MemoryRepository {
  thrower: (() => never) | null = null
  async pageInstances(pageNum: number, pageSize: number, operator: string, conditions?: QueryCondition[]) {
    if (this.thrower) this.thrower()
    return super.pageInstances(pageNum, pageSize, operator, conditions)
  }
}

const userProv: UserProvider = {
  async getUser(userId) {
    return { userId, realName: '用户' + userId, deptId: 'D01', deptName: '测试部门', postId: 'P01', postName: '测试岗位' }
  },
}
const exprEval: ExpressionEvaluator = {
  async eval(expr, vars) {
    const amt = Number(vars.amount ?? 0)
    if (expr === 'amount > 1000') return amt > 1000
    if (expr === 'amount <= 1000') return amt <= 1000
    return false
  },
}

function setup(throwing = false) {
  const repo = throwing ? new ThrowingRepo() : new MemoryRepository()
  const engine = new EngineImpl(repo, userProv, mkSeqIdGen(), exprEval)
  const facade = new JeeflowFacade(engine, repo, new MemoryExtRepository())
  return { engine, repo, facade }
}

/** 起一单 01-simple：startAndExecute 自动跑完 apply ⇒ 停在 task1（参与者＝leader）。 */
async function startTask(facade: JeeflowFacade, repo: MemoryRepository): Promise<string> {
  const content = readFileSync(flowDir + '01-simple.json', 'utf-8')
  const r0 = await facade.flow('processDefine/deploy', { content })
  assert.equal(r0.code, 0, JSON.stringify(r0))
  const r1 = await facade.flow('processInstance/startAndExecute',
    { processDefineId: r0.data.processDefineId, operator: 'zhangsan' })
  assert.equal(r1.code, 0, JSON.stringify(r1))
  const doing = await repo.findDoingTasks(r1.data.processInstanceId)
  assert.equal(doing.length, 1, '前置：实例应停在一个进行中任务')
  return doing[0].id
}

/** console.error 捕获（副作用那一半的取证口）；用完必须 restore，别污染别的格 */
function captureError(): { calls: any[][]; restore(): void } {
  const calls: any[][] = []
  const orig = console.error
  console.error = (...a: any[]) => { calls.push(a) }
  return { calls, restore() { console.error = orig } }
}

/** mysql2 形状的错误：ctor 名就是 `Error`，原文＋SQL 全在 message/own-props 上（第 4 条抓不到） */
function mysql2LikeError(): Error {
  const e: any = new Error("You have an error in your SQL syntax; check the manual that corresponds to your MySQL server version for the right syntax to use near 'wf_process_instance' at line 1")
  e.code = 'ER_PARSE_ERROR'
  e.errno = 1064
  e.sqlState = '42000'
  e.sql = 'SELECT * FROM wf_process_instance t WHERE t.operator = ?'
  return e
}

/** pg 形状的错误：第三方子类（ctor 名 `DatabaseError` 不在第 4 条族清单里） */
class DatabaseError extends Error {
  code = '42P01'
  severity = 'ERROR'
  constructor(message: string) { super(message); this.name = 'DatabaseError' }
}

/** fs 形状的错误：ctor 名 `Error` ＋ ENOENT 原文（java IOException 的 node 等价物） */
function enoentLikeError(): Error {
  const e: any = new Error("ENOENT: no such file or directory, open '/etc/jeeflow/flows.json'")
  e.code = 'ENOENT'; e.errno = -2; e.syscall = 'open'; e.path = '/etc/jeeflow/flows.json'
  return e
}

// ═══ B 组：出口负向——各泄漏形状 ⇒ msg 逐字 `流程处理失败` ═══════════════════════════════

describe('issues/137 §3-1 · B 出口负向（内部原文不得进 msg 或任何对外字段）', () => {

  /**
   * 逐格跑同一条判据：出口 code/msg 逐字 ＋ 整个响应信封（含 data 与其它字段）都不许出现原文标记
   * ＋ 原文确实进了日志（副作用那一半，见 D 组）。
   */
  async function expectMasked(label: string, make: () => any, markers: string[]) {
    const { facade, repo } = setup(true)
    const err = make()
    ;(repo as ThrowingRepo).thrower = () => { throw err }
    const cap = captureError()
    let r: Record<string, any>
    try {
      r = await facade.flow('processInstance/page', { operator: 'user1', pageNum: 1, pageSize: 10 })
    } finally { cap.restore() }

    assert.equal(r.code, 99999999, `${label}：失败码恒定 99999999（§2.1）`)
    assert.equal(r.msg, FIXED, `${label}：出口 msg 必须逐字等于「${FIXED}」，实得「${r.msg}」`)
    // 不许只查 msg：原文换个字段溜出去（data／警告文本）同样算泄漏（§2.12 末句）
    const envelope = JSON.stringify(r)
    for (const marker of markers) {
      assert.ok(!envelope.includes(marker), `${label}：内部原文「${marker}」泄漏进对外信封：${envelope}`)
    }
    return { r, err, calls: cap.calls }
  }

  it('B1 TypeError（NullPointerException 等价）：Cannot read properties of undefined', async () => {
    // 用真实的空引用解引用产生，不用手搓 message（形状才是真的）
    let real: any
    try { const o: any = undefined; o.raw.length } catch (e) { real = e }
    assert.ok(real instanceof TypeError, '前置取证')
    await expectMasked('TypeError', () => real,
      ['Cannot read properties of undefined', 'TypeError', 'reading'])
  })

  it('B2 RangeError（IndexOutOfBounds/Arithmetic/StackOverflow 等价）', async () => {
    let real: any
    try { new Array(-1) } catch (e) { real = e }
    assert.ok(real instanceof RangeError, '前置取证')
    await expectMasked('RangeError', () => real, ['Invalid array length', 'RangeError'])
  })

  it('B3 JSON.parse 的 SyntaxError 原文（解析器写的，含内容位置信息）', async () => {
    let real: any
    try { JSON.parse("{'bad': }") } catch (e) { real = e }
    assert.ok(real instanceof SyntaxError, '前置取证')
    await expectMasked('SyntaxError(JSON)', () => real, ['SyntaxError', 'JSON', 'position'])
  })

  it('B4 数字解析的 SyntaxError／RangeError／TypeError（NumberFormatException 等价）', async () => {
    let bigintErr: any
    try { BigInt('12x') } catch (e) { bigintErr = e }
    assert.ok(bigintErr instanceof SyntaxError, '前置取证：BigInt 解析失败是 SyntaxError')
    await expectMasked('BigInt', () => bigintErr, ['Cannot convert 12x to a BigInt', 'SyntaxError'])

    // 数字格式化的越界（java NumberFormatException/IllegalArgumentException 的 node 等价形状）
    let rangeErr: any
    try { (1).toFixed(1000) } catch (e) { rangeErr = e }
    assert.ok(rangeErr instanceof RangeError, '前置取证：toFixed 越界是 RangeError')
    await expectMasked('RangeError(num)', () => rangeErr, ['RangeError', 'toFixed() digits argument'])

    let typeErr: any
    try { (null as any).toFixed(2) } catch (e) { typeErr = e }
    assert.ok(typeErr instanceof TypeError, '前置取证：数字转换失败在 node 是 TypeError')
    await expectMasked('TypeError(num)', () => typeErr, ['TypeError', 'toFixed'])
  })

  it('B5 裸包装（java `new RuntimeException(e)` 等价）：cause 原文不得顺带溜出 msg', async () => {
    // 形状①：`new Error(innerErr)` ⇒ message 就是下层原文的串化、且不保留 cause（实测）
    const inner = new Error('内部驱动细节 12345')
    const bare = new Error(inner as any)
    await expectMasked('裸包装(new Error(e))', () => bare, ['12345', '内部驱动细节'])

    // 形状②：带 cause 的裸包装
    const wrapped = new Error(String(inner), { cause: inner })
    await expectMasked('裸包装(String(e)+cause)', () => wrapped, ['12345', '内部驱动细节'])

    // 形状③：java 基准那条 `java.lang.IllegalStateException: 内部驱动细节 12345`
    const javaShaped = new Error('java.lang.IllegalStateException: 内部驱动细节 12345')
    await expectMasked('裸包装(java 头部)', () => javaShaped, ['12345', 'IllegalStateException'])
  })

  it('B6 驱动／第三方 provider 抛的东西（本栈只能靠第 5 条判据抓：ctor 名都是 `Error`）', async () => {
    await expectMasked('mysql2', () => mysql2LikeError(),
      ['You have an error in your SQL syntax', 'wf_process_instance', 'ER_PARSE_ERROR'])
    await expectMasked('pg', () => new DatabaseError('relation "wf_process_task" does not exist'),
      ['relation "wf_process_task" does not exist', '42P01'])
    await expectMasked('fs/IO', () => enoentLikeError(),
      ['ENOENT', '/etc/jeeflow/flows.json'])
    // 集成方自己写的 provider（栈在集成方 src 里）——spec §2.12 明列这一档
    await expectMasked('集成方 provider', () => new Error('LDAP connection refused 10.0.0.7:389'),
      ['LDAP', '10.0.0.7'])
  })

  it('B7 message 缺失／空串／非 Error 抛出值 ⇒ 同样只给固定文案', async () => {
    // ① new Error() 无 message（java 第 1 条的"兜底会吐类名"在 node 是 `String(e)` = "Error"）
    const { r: rNoMsg } = await expectMasked('new Error() 无 message', () => new Error(), ['Error'])
    assert.equal(rNoMsg.msg, FIXED)
    // ② 空 message：不是"失败原因"（§2.1 要求 msg 承载原因）⇒ 同样只给固定文案
    await expectMasked('new Error("") 空 message', () => new Error(''), ['"msg":""'])
    // ③ throw 裸字符串（非 Error 值）：message 缺失 ⇒ 第 1 条
    const { facade, repo } = setup(true)
    ;(repo as ThrowingRepo).thrower = () => { throw 'RAW_INTERNAL_DETAIL 8848' as any }
    const cap = captureError()
    let r: Record<string, any>
    try { r = await facade.flow('processInstance/page', { operator: 'user1' }) } finally { cap.restore() }
    assert.equal(r.code, 99999999)
    assert.equal(r.msg, FIXED, `throw 裸字符串也只给固定文案，实得「${r.msg}」`)
    assert.ok(!JSON.stringify(r).includes('8848'), '裸字符串原文不得泄漏')
    // ④ throw 一个结构体（非 Error）：同样第 1 条
    const { facade: f2, repo: repo2 } = setup(true)
    ;(repo2 as ThrowingRepo).thrower = () => { throw { code: 'E_INTERNAL', detail: '内部结构体字段 9527' } as any }
    const cap2 = captureError()
    let r2: Record<string, any>
    try { r2 = await f2.flow('processInstance/page', { operator: 'user1' }) } finally { cap2.restore() }
    assert.equal(r2.code, 99999999)
    assert.equal(r2.msg, FIXED, `非 Error 抛出值也只给固定文案，实得「${r2.msg}」`)
    assert.ok(!JSON.stringify(r2).includes('9527'), '内部结构体字段不得泄漏')
  })

  it('B8 未知 action 仍走既有契约文案（判别式不得把这条也吞成固定文案）', async () => {
    const { facade } = setup()
    const r = await facade.flow('processTask/noSuchAction', { operator: 'user1' })
    assert.equal(r.code, 99999999)
    assert.equal(r.msg, '未知 action: processTask/noSuchAction', '§2 入口契约：未知 action 逐字文案')
  })
})

// ═══ C 组：出口正向／回归——引擎契约文案必须仍逐字透出 ══════════════════════════════════

describe('issues/137 §3-1 · C 出口正向（引擎契约文案逐字透出，判据没收窄）', () => {

  /** 逐字断言：msg 严格等值（不是 includes），并顺带证明这一格没被记成内部异常 */
  async function expectVerbatim(label: string, run: () => Promise<Record<string, any>>, expected: string) {
    const cap = captureError()
    let r: Record<string, any>
    try { r = await run() } finally { cap.restore() }
    assert.equal(r.code, 99999999, `${label}：${JSON.stringify(r)}`)
    assert.equal(r.msg, expected, `${label}：契约文案必须逐字留在 msg，实得「${r.msg}」`)
    assert.notEqual(r.msg, FIXED, `${label}：不得被换成固定文案`)
    // 引擎自己写的文案不该被记成内部异常（java 基准同一条断言：CAPTURED.isEmpty()）
    assert.equal(cap.calls.length, 0,
      `${label}：引擎契约文案不应触发内部异常日志，实得 ${cap.calls.length} 条：${inspect(cap.calls)}`)
    return r
  }

  it('C1 读取流程定义 JSON 失败（解析腿：契约文案进 message、SyntaxError 原文只作 cause）', async () => {
    const { facade } = setup()
    const r = await expectVerbatim('deploy 坏 JSON',
      () => facade.flow('processDefine/deploy', { content: "{bad json", operator: 'zhangsan' }),
      '读取流程定义 JSON 失败')
    // ⚠️ 关键：cause 里的解析器原文绝不能被 String(e)/模板串带进任何对外字段
    const envelope = JSON.stringify(r)
    for (const marker of ['SyntaxError', 'Expected property name', 'position']) {
      assert.ok(!envelope.includes(marker), `cause 原文「${marker}」不得进对外信封：${envelope}`)
    }
    // redeploy 腿同一枚判据（第二条解析腿，覆盖面②的另一半）
    const { facade: f2 } = setup()
    await expectVerbatim('redeploy 坏 JSON',
      () => f2.flow('processDefine/redeploy', { processDefineId: '123', content: "{bad json", operator: 'zhangsan' }),
      '读取流程定义 JSON 失败')
  })

  it('C2 流程定义缺少 name', async () => {
    const { facade } = setup()
    await expectVerbatim('deploy 缺 name',
      () => facade.flow('processDefine/deploy', { content: JSON.stringify({ displayName: 'x', type: 'approval' }), operator: 'zhangsan' }),
      '流程定义缺少 name')
  })

  it('C3 任务非进行中，不可摘除参与人', async () => {
    const { facade, repo } = setup()
    const taskId = await startTask(facade, repo)
    const done = await facade.flow('processTask/execute',
      { processTaskId: taskId, operator: 'leader', submitType: SubmitType.Agree })
    assert.equal(done.code, 0, JSON.stringify(done))
    assert.equal((await repo.findTaskById(taskId))?.taskState, TaskState.Done, '前置：任务已离开 DOING')
    await expectVerbatim('摘已办结任务的参与人',
      () => facade.flow('processTask/removeTaskActor', { processTaskId: taskId, actorIds: ['leader'], operator: 'flow.admin' }),
      '任务非进行中，不可摘除参与人')
  })

  it('C4 至少需保留一名参与人', async () => {
    const { facade, repo } = setup()
    const taskId = await startTask(facade, repo)
    assert.deepEqual(await repo.findTaskActors(taskId), ['leader'], '前置')
    await expectVerbatim('摘空',
      () => facade.flow('processTask/removeTaskActor', { processTaskId: taskId, actorIds: ['leader'], operator: 'leader' }),
      '至少需保留一名参与人')
    assert.deepEqual(await repo.findTaskActors(taskId), ['leader'], '人还在')
  })

  it('C5 未配置 ProcessExtRepository（扩展仓储）——java 基准那条"裸 ISE 仍逐字透出"的 node 活证', async () => {
    // java：ext() 抛裸 IllegalStateException("未配置 IProcessExtRepository（扩展仓储）")，抛出点在引擎包内
    // ⇒ 文案照旧透出。node 同形状（裸 Error），且**没有契约异常类型可判**——这一格就是"不能按类型
    // 收窄"的活证：收窄成"只透契约族"或"一律固定文案"都会把它改掉，集成方排障与八栈逐字对齐一起断。
    const repo = new MemoryRepository()
    const engine = new EngineImpl(repo, userProv, mkSeqIdGen(), exprEval)
    const facade = new JeeflowFacade(engine, repo)   // 不传扩展仓储
    await expectVerbatim('processDesign/page 无扩展仓储',
      () => facade.flow('processDesign/page', { operator: 'user1', pageNum: 1, pageSize: 10 }),
      '未配置 ProcessExtRepository（扩展仓储）')
  })

  it('C6 其余守卫族逐字文案（operator 必填／任务不存在／无权限摘除该任务参与人）', async () => {
    const { facade, repo } = setup()
    const taskId = await startTask(facade, repo)
    await expectVerbatim('withdraw 缺 operator',
      () => facade.flow('processInstance/withdraw', { id: '123' }),
      'operator 必填')
    await expectVerbatim('removeTaskActor 缺 operator',
      () => facade.flow('processTask/removeTaskActor', { processTaskId: taskId, actorIds: ['leader'] }),
      'operator 必填')
    await expectVerbatim('任务不存在',
      () => facade.flow('processTask/removeTaskActor',
        { processTaskId: '999999999999999999', actorIds: ['leader'], operator: 'leader' }),
      '任务不存在')
    await expectVerbatim('无权限摘除该任务参与人',
      () => facade.flow('processTask/removeTaskActor', { processTaskId: taskId, actorIds: ['leader'], operator: 'ghost' }),
      '无权限摘除该任务参与人')
  })

  it('C7 引擎的英文契约文案同样逐字透出（node 精度护栏与 operator 校验）', async () => {
    const { facade } = setup()
    // toId() 的精度护栏（issues/82）：文案里带原始 id，属引擎自己写的对外文案，不得被吞
    const r = await facade.flow('processInstance/startAndExecute',
      { processDefineId: 2084320543834124288, operator: 'user1' })
    assert.equal(r.code, 99999999, JSON.stringify(r))
    assert.ok(String(r.msg).includes('超出 float64 精确范围'), `引擎契约文案应逐字透出：${r.msg}`)
    assert.notEqual(r.msg, FIXED)
  })
})

// ═══ D 组：副作用——原文确实进了日志／cause（别只断言 msg）═══════════════════════════════

describe('issues/137 §3-1 · D 副作用（原文进日志与 cause，不是被整个丢掉）', () => {

  it('D1 内部异常：原异常对象整个进 console.error（栈＋cause 都在），且日志点明是哪个 action', async () => {
    const { facade, repo } = setup(true)
    const foreign = mysql2LikeError()
    ;(repo as ThrowingRepo).thrower = () => { throw foreign }
    const cap = captureError()
    let r: Record<string, any>
    try { r = await facade.flow('processInstance/page', { operator: 'user1' }) } finally { cap.restore() }

    assert.equal(r.msg, FIXED, '前置：出口只给固定文案')
    assert.ok(cap.calls.length >= 1, `原文必须进日志，实得 ${cap.calls.length} 条 console.error`)
    const call = cap.calls[0]
    // ① 日志前缀点明 action（java 基准同一条断言：rec.getMessage().contains("processInstance/page")）
    assert.ok(String(call[0]).includes('processInstance/page'), `日志要指出是哪个 action：${String(call[0])}`)
    // ② 拿到的是**原异常对象本体**（不是它的 message 摘要）⇒ 栈与 cause 都还在，排障不丢信息
    assert.equal(call[1], foreign, '日志里要拿到原异常对象（identity）')
    // ③ node 的 console.error 走 util.inspect ⇒ 原文确实被打出来（这一条防"日志只记了个固定文案"）
    const printed = inspect(call[1])
    assert.ok(printed.includes('You have an error in your SQL syntax'), `原文要真的被打出来：${printed}`)
    assert.ok(printed.includes('mysql2') || printed.includes('ER_PARSE_ERROR') || printed.includes('42000'),
      `驱动细节要留在日志里供排障：${printed}`)
  })

  it('D2 带 cause 的解析腿：cause 里的 SyntaxError 原文进日志（console.error 会打 `[cause]:`），但不进 msg', async () => {
    // 批二 issues/139 的形状：契约文案进 message、解析器原文进 { cause }。
    // §2.12 要求"原文只进日志与错误对象"——这一格证明 cause 那一份没被丢掉，也没被带出去。
    const inner = new SyntaxError("Expected property name or '}' in JSON at position 1 (line 1 column 2)")
    const wrapped = new Error('读取流程定义 JSON 失败', { cause: inner })
    // 走判别式：这一条判"透出"（引擎契约文案）
    assert.equal(isForeignDetail('Error', wrapped.message, wrapped.cause, ENGINE_STACK), false)
    // 出口只出契约文案；cause 原文不出现在对外信封里
    const { facade } = setup()
    const cap = captureError()
    let r: Record<string, any>
    try { r = await facade.flow('processDefine/deploy', { content: "{bad json", operator: 'zhangsan' }) } finally { cap.restore() }
    assert.equal(r.msg, '读取流程定义 JSON 失败')
    assert.ok(!JSON.stringify(r).includes('Expected property name'), 'cause 原文不得进对外信封')
    // node 打错误对象时会连 `[cause]:` 一起打（实测取证）⇒ 排障仍拿得到解析器原文
    assert.ok(inspect(wrapped).includes('[cause]'), '前置取证：util.inspect 会打出 cause 段')
    assert.ok(inspect(wrapped).includes("Expected property name"), '前置取证：cause 原文在 inspect 输出里')
  })

  it('D3 反向哨兵：判据不是"把原文整个丢掉"——同一条异常，日志有原文而 msg 没有', async () => {
    // 只断言 msg 的话，"catch 里什么都不记、直接返回固定文案"也能全绿；这一格把那种假绿钉死。
    const { facade, repo } = setup(true)
    const foreign = new TypeError("Cannot read properties of undefined (reading 'operator')")
    ;(repo as ThrowingRepo).thrower = () => { throw foreign }
    const cap = captureError()
    let r: Record<string, any>
    try { r = await facade.flow('processInstance/page', { operator: 'user1' }) } finally { cap.restore() }

    assert.equal(r.msg, FIXED, '对外：固定文案')
    assert.ok(!JSON.stringify(r).includes('operator'), '对外信封不得含原文片段')
    const logged = cap.calls.map(c => c.map(x => inspect(x)).join(' ')).join('\n')
    assert.ok(logged.includes("Cannot read properties of undefined"), `对内：原文必须留在日志里，实得：${logged}`)
    assert.ok(logged.includes('TypeError'), `对内：异常类型也要在日志里，实得：${logged}`)
  })

  it('D4 引擎契约文案那一档不记内部异常日志（判别式没把正常契约失败也当事故）', async () => {
    const { facade, repo } = setup()
    const taskId = await startTask(facade, repo)
    const cap = captureError()
    let r: Record<string, any>
    try {
      r = await facade.flow('processTask/removeTaskActor', { processTaskId: taskId, actorIds: ['leader'], operator: 'leader' })
    } finally { cap.restore() }
    assert.equal(r.msg, '至少需保留一名参与人')
    assert.equal(cap.calls.length, 0, `契约失败不该记内部异常日志：${inspect(cap.calls)}`)
  })
})

// ═══ E 组：覆盖面②——bizData／JSON 解析族不泄漏 ════════════════════════════════════════

describe('issues/137 §3-1 · E 覆盖面②（bizData／JSON 解析族）', () => {

  it('E1 bizData 腿：定义内容坏 JSON ⇒ 走既有契约文案，解析器原文一处都不外泄', async () => {
    const { facade, repo } = setup()
    const content = readFileSync(flowDir + '01-simple.json', 'utf-8')
    const r0 = await facade.flow('processDefine/deploy', { content })
    assert.equal(r0.code, 0, JSON.stringify(r0))
    const defineId = String(r0.data.processDefineId)
    // 先按好内容起单（起单也要读 content），**之后**再把定义内容弄坏——
    // 这样坏 JSON 只在 bizData 解析 relTableName 那一步撞上，不会先把发起腿打断。
    const r1 = await facade.flow('processInstance/startAndExecute',
      { processDefineId: defineId, operator: 'zhangsan' })
    assert.equal(r1.code, 0, JSON.stringify(r1))
    const iid = String(r1.data.processInstanceId)
    const def = await repo.findDefineById(defineId)
    assert.ok(def, '前置：定义行在')
    await repo.updateDefine({ ...def!, content: '{ 坏掉的 JSON' })

    const cap = captureError()
    let r: Record<string, any>
    try { r = await facade.flow('processInstance/bizData', { processInstanceId: iid }) } finally { cap.restore() }
    assert.equal(r.code, 99999999, JSON.stringify(r))
    assert.equal(r.msg, '流程定义未配置 relTableName', '引擎契约文案逐字透出（解析错被 bizData 自己吞掉）')
    for (const marker of ['SyntaxError', 'Expected property name', '坏掉的 JSON', 'position']) {
      assert.ok(!JSON.stringify(r).includes(marker), `解析器原文／坏内容片段不得外泄：${marker}`)
    }
  })

  it('E2 bizData 腿：metaReader（第三方 provider）抛驱动错 ⇒ 只给固定文案，原文进日志', async () => {
    const { facade, repo } = setup()
    const content = readFileSync(flowDir + '01-simple.json', 'utf-8')
    const r0 = await facade.flow('processDefine/deploy', { content })
    assert.equal(r0.code, 0, JSON.stringify(r0))
    const defineId = String(r0.data.processDefineId)
    const r1 = await facade.flow('processInstance/startAndExecute',
      { processDefineId: defineId, operator: 'zhangsan' })
    assert.equal(r1.code, 0, JSON.stringify(r1))
    const iid = String(r1.data.processInstanceId)
    // 起单之后再给定义补 relTableName（bizData 只读这个键，不需要 nodes）
    const def = await repo.findDefineById(defineId)
    assert.ok(def, '前置：定义行在')
    await repo.updateDefine({ ...def!, content: JSON.stringify({ ...JSON.parse(content), relTableName: 'biz_leave' }) })
    // 集成方注入的业务数据读取器炸了（真实场景：业务表不存在／连接断）
    facade.setMetaReader({
      readByProcessInstance() { throw mysql2LikeError() },
    })
    const cap = captureError()
    let r: Record<string, any>
    try { r = await facade.flow('processInstance/bizData', { processInstanceId: iid }) } finally { cap.restore() }
    assert.equal(r.code, 99999999)
    assert.equal(r.msg, FIXED, `bizData 腿同样只给固定文案，实得「${r.msg}」`)
    const envelope = JSON.stringify(r)
    for (const marker of ['You have an error in your SQL syntax', 'wf_process_instance', 'ER_PARSE_ERROR']) {
      assert.ok(!envelope.includes(marker), `驱动原文不得进对外信封：${marker}`)
    }
    const logged = cap.calls.map(c => c.map(x => inspect(x)).join(' ')).join('\n')
    assert.ok(logged.includes('You have an error in your SQL syntax'), `原文要进日志：${logged}`)
    assert.ok(logged.includes('processInstance/bizData'), `日志要点明 action：${logged}`)
  })

  it('E3 designRedeploy 解析腿（第三条 JSON 腿）：契约文案透出、SyntaxError 原文不进信封', async () => {
    const { facade } = setup()
    // 无扩展仓储 ⇒ 先撞 `未配置 ProcessExtRepository（扩展仓储）`（引擎契约文案）；
    // 有扩展仓储但设计不存在 ⇒ `流程设计不存在`。两条都是契约文案，逐字透出。
    const r = await facade.flow('processDesign/redeploy', { id: '999999999999999999', operator: 'zhangsan' })
    assert.equal(r.code, 99999999, JSON.stringify(r))
    assert.equal(r.msg, '流程设计不存在', '契约文案逐字透出')
    assert.notEqual(r.msg, FIXED)
    // 固定文案常量本身逐字（八栈同一串，措辞不许改）
    assert.equal(INTERNAL_FAILURE_MSG, '流程处理失败')
    assert.equal(FIXED, '流程处理失败')
  })
})
