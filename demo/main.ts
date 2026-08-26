// jeeflow-node Express demo —— 统一门面单入口（对齐 Java/Go/Python demo）
//
// 能力面：
// - POST /wf/{action}：统一门面转发（40 action 全可达）
// - GET /healthz：健康检查；GET /api/stats：统计（operator 口径，四端统一）
// - POST /api/reset：一键重置演示数据并重载种子流程定义
// - 接入内存扩展仓储（design/surrogate 可用）+ 用户搜索/组织提供者（candidatePage 闭环）
// - 8 个具名用户四端统一：user1=张三、leader=李四(组长)、manager=王五(经理)…
import express from 'express'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EngineImpl } from '../src/engine.js'
import { JeeflowFacade as Facade } from '../src/facade.js'
import { MemoryRepository } from '../src/memory.js'
import { MemoryExtRepository } from '../src/memory-ext.js'
import { HandlerRegistry } from '../src/registry.js'
import { registerBuiltinAssignments } from '../src/builtin.js'
import { dir as flowsResolverDir } from '../flows-resolver.js'
import type { ProcessDefine, UserInfo } from '../src/model.js'
import type { UserProvider, OrgUserProvider } from '../src/spi.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── 四端统一 8 个具名用户（切换后端不再"换人"）────────────────────────────────
const DEMO_USERS: Record<string, { realName: string; postName: string }> = {
  user1: { realName: '张三', postName: '工程师' },
  userA: { realName: '孙倩', postName: '工程师' },
  userB: { realName: '周明', postName: '工程师' },
  userC: { realName: '吴婷', postName: '工程师' },
  leader: { realName: '李四', postName: '组长' },
  manager: { realName: '王五', postName: '经理' },
  director: { realName: '赵六', postName: '总监' },
  boss: { realName: '钱七', postName: '总经理' },
}

const demoUserMap = (uid: string): Record<string, any> => {
  const u = DEMO_USERS[uid]
  return {
    userId: uid,
    realName: u ? u.realName : '用户' + uid,
    deptId: 'D01', deptName: '研发部',
    postId: 'P01', postName: u ? u.postName : '工程师',
  }
}

const userProvider: UserProvider = {
  async getUser(userId: string): Promise<UserInfo | null> {
    const u = DEMO_USERS[userId]
    return {
      userId,
      realName: u ? u.realName : '用户' + userId,
      deptId: 'D01', deptName: '研发部',
      postId: 'P01', postName: u ? u.postName : '工程师',
    }
  },
}

// 组织维度取人（部门领导/分管领导/角色），扁平演示组织结构
const orgProvider: OrgUserProvider = {
  async findDeptLeaders(_deptId: string) { return ['leader'] },
  async findDeptMainLeaders(_deptId: string) { return ['manager'] },
  async findByRole(roleCode: string) {
    return ({ leader: ['leader'], manager: ['manager'], director: ['director'], boss: ['boss'] } as Record<string, string[]>)[roleCode] ?? []
  },
}

// 用户搜索钩子（candidatePage 依赖）：在 8 个演示用户内分页检索，m_* 条件值按关键字包含匹配
const userSearch = (query: Record<string, any>): [Record<string, any>[], number] => {
  const keywords = Object.entries(query)
    .filter(([k, v]) => k.startsWith('m_') && String(v ?? '').trim() !== '')
    .map(([, v]) => String(v).trim().toLowerCase())
  const all = Object.keys(DEMO_USERS)
    .filter(uid => {
      if (keywords.length === 0) return true
      const { realName } = DEMO_USERS[uid]
      return keywords.every(kw => uid.toLowerCase().includes(kw) || realName.toLowerCase().includes(kw))
    })
    .map(demoUserMap)
  const pageNum = Math.max(1, Number(query.pageNum) || 1)
  const pageSize = Math.max(1, Number(query.pageSize) || 10)
  const start = Math.min((pageNum - 1) * pageSize, all.length)
  return [all.slice(start, start + pageSize), all.length]
}

// ─── 组装（启动与 /api/reset 复用）──────────────────────────────────────────────
let repo = new MemoryRepository()
let ext = new MemoryExtRepository()
let engine: EngineImpl
let facade: Facade

function buildAll() {
  repo = new MemoryRepository()
  ext = new MemoryExtRepository()
  engine = new EngineImpl(repo, userProvider, undefined, {
    async eval(expr: string, vars: Record<string, any>) {
      const amt = Number(vars?.amount)
      if (isNaN(amt)) return false
      if (expr === 'amount > 1000') return amt > 1000
      if (expr === 'amount >= 1000') return amt >= 1000
      if (expr === 'amount < 1000') return amt < 1000
      if (expr === 'amount <= 1000') return amt <= 1000
      if (expr === 'amount == 1000') return amt === 1000
      if (expr === 'amount != 1000') return amt !== 1000
      return false
    }
  })
  // 内置参与者 handler（部门领导/角色取人等，assignment-handler 流程依赖）
  const reg = new HandlerRegistry()
  registerBuiltinAssignments(reg, userProvider, orgProvider)
  engine.setRegistry(reg)
  loadSeed()
  facade = new Facade(engine, repo, ext).setUserSearch(userSearch).setOrgProvider(orgProvider)
}

// 从本仓 flows/ 加载种子流程（flows-resolver 已在维护者机器上把 Java 源精确镜像进来）
function loadSeed() {
  const flowsDir = flowsResolverDir()
  const files = readdirSync(flowsDir).filter(f => f.endsWith('.json')).sort()
  files.forEach((fname, i) => {
    const content = readFileSync(join(flowsDir, fname), 'utf-8')
    const raw = JSON.parse(content)
    const def: ProcessDefine = {
      id: String(i + 1),  // Node 引擎 id 约定为 string（issue 38 E9）
      name: raw.name || fname,
      displayName: raw.displayName || fname,
      type: raw.type || 'approval',
      state: 1, version: 1,
      content,
      createTime: new Date(), updateTime: new Date(),
      createUser: '', updateUser: '',
    }
    repo.addDefine(def)
    console.log(`  loaded: ${def.id} ${def.displayName}`)
  })
}

buildAll()

const app = express()
app.use(express.json())

// CORS——允许 jeeflow-ui (localhost:5173) 跨域访问
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS, PUT, DELETE')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (_req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

// ─── 运维端点（四端对齐）───────────────────────────────────────────────────────
app.get('/healthz', (_req, res) => {
  res.json({ status: 'UP', backend: 'node' })
})

// 统计（四端统一口径：todoCount 按任务参与者，myInstanceCount 按 instance.operator）
app.get('/api/stats', async (req, res) => {
  const userId = String(req.query.userId ?? 'user1')
  let todoCount = 0
  for (const t of repo.allTasks()) {
    if (t.taskState !== 10) continue // TaskState.Doing
    const actors = await repo.findTaskActors(t.id)
    if (t.actorIds.includes(userId) || actors.includes(userId)) todoCount++
  }
  let myInstanceCount = 0
  for (const i of repo.allInstances()) if (i.operator === userId) myInstanceCount++
  res.json({ code: 0, msg: '成功', data: { todoCount, myInstanceCount } })
})

// 一键重置演示数据（对齐 Python /api/reset）：重建内存库与扩展仓储 + 重载种子流程定义
app.post('/api/reset', (_req, res) => {
  buildAll()
  res.json({ code: 0, msg: '成功', data: null })
})

// ─── 统一门面转发（v1.5.0）：/wf/{action}，action 多段（如 processDefine/page）──────────────
app.post('/wf/*', async (req, res) => {
  try {
    const action = String(req.params[0] ?? '').replace(/^\//, '')
    const body = req.body ?? {}
    res.json(await facade.flow(action, body))
  } catch (e: any) {
    res.json({ code: 99999999, msg: e.message })
  }
})

app.listen(8082, () => console.log('jeeflow-node → http://localhost:8082'))
