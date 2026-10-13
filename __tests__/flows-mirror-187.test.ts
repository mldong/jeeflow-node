// issues/187：flows 镜像的原子性与稳态零写。
//
// 旧形状＝逐份 `writeFileSync`（truncate→write 非原子）＋每个测试进程 import 时都跑一遍 ⇒
// `node --test __tests__/*.test.ts` 并行 12 文件时，读侧间歇撞半写态，既有用例随机红。
// 这里把"撞得上"做成稳定形状（多份大夹具＋多进程读写对拍），而不是等偶现。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mirror } from '../flows-resolver.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const RESOLVER_URL = pathToFileURL(join(HERE, '..', 'flows-resolver.ts')).href
const TSX_URL = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
const JAVA_REL = join('jeeflow-java', 'jeeflow-core', 'src', 'test', 'resources', 'flows')

const FILES = ['01-a.json', '02-b.json', '03-c.json', '04-d.json', '05-e.json', '06-f.json']
const PAD = 1024 * 1024 // 撑开写入窗口：真件 JSON 只有几 KB，窗口微秒级，全量套件撞不上（187 立案时"并行 2 跑 1 红"就是这个量级）
const body = (ch: string, n = PAD) => JSON.stringify({ id: 1, pad: ch.repeat(n) })

/** 造一棵假仓树：<root>/proj/flows + <root>/jeeflow-java/.../flows（mirror 认的兄弟目录布局）。 */
function makeTree() {
  const root = mkdtempSync(join(tmpdir(), 'i187-'))
  const proj = join(root, 'proj')
  const javaFlows = join(root, JAVA_REL)
  mkdirSync(join(proj, 'flows'), { recursive: true })
  mkdirSync(javaFlows, { recursive: true })
  return { proj, javaFlows, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function child(script: string, args: string[]) {
  return new Promise<{ code: number; err: string }>((resolve, reject) => {
    const p = spawn(process.execPath, ['--import', TSX_URL, script, ...args])
    let err = ''
    p.stderr.on('data', (d) => (err += d))
    p.on('error', reject)
    p.on('close', (code) => resolve({ code: code ?? -1, err }))
  })
}

test('i187 镜像语义：全量复制 + 删孤儿 + 稳态零写 + 无 Java 源静默', () => {
  const { proj, javaFlows, cleanup } = makeTree()
  try {
    writeFileSync(join(javaFlows, '01-a.json'), body('a', 64))
    writeFileSync(join(proj, 'flows', 'orphan.json'), '{"id":99}')

    mirror(proj)
    assert.equal(readFileSync(join(proj, 'flows', '01-a.json'), 'utf8'), body('a', 64), 'Java 源应整份镜像')
    assert.equal(existsSync(join(proj, 'flows', 'orphan.json')), false, '孤儿 .json 应被删')

    // 稳态零写：内容没变就一个字节都不许动（mtime 不变 ⇒ 读者窗口根本不存在）
    const before = statSync(join(proj, 'flows', '01-a.json')).mtimeMs
    mirror(proj)
    mirror(proj)
    assert.equal(statSync(join(proj, 'flows', '01-a.json')).mtimeMs, before, '内容相同不得重写')
    assert.deepEqual(readdirSync(join(proj, 'flows')).filter((f) => f.includes('.tmp.')), [], '不该留下临时件')

    // 内容变了要落盘
    writeFileSync(join(javaFlows, '01-a.json'), body('b', 64))
    mirror(proj)
    assert.equal(readFileSync(join(proj, 'flows', '01-a.json'), 'utf8'), body('b', 64), '源变更应镜像落盘')

    // 无 Java 源（用户单仓 / 容器）：静默跳过，不抛不写
    const bare = mkdtempSync(join(tmpdir(), 'i187-bare-'))
    try {
      mkdirSync(join(bare, 'flows'), { recursive: true })
      writeFileSync(join(bare, 'flows', 'keep.json'), '{"id":7}')
      mirror(bare)
      assert.equal(readFileSync(join(bare, 'flows', 'keep.json'), 'utf8'), '{"id":7}')
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  } finally {
    cleanup()
  }
})

test('i187 并发读写：多进程镜像时读者不得撞半写', async () => {
  const { proj, javaFlows, cleanup } = makeTree()
  const readerDir = mkdtempSync(join(tmpdir(), 'i187-r-'))
  try {
    for (const f of FILES) writeFileSync(join(javaFlows, f), body('a'))
    mirror(proj) // 先就位，读者首轮就有东西读

    writeFileSync(
      join(proj, 'writer.mjs'),
      `import { writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { mirror } from ${JSON.stringify(RESOLVER_URL)}
const [root, javaFlows, iters, padLen, filesArg] = process.argv.slice(2)
const files = filesArg.split(',')
const A = JSON.stringify({ id: 1, pad: 'a'.repeat(Number(padLen)) })
const B = JSON.stringify({ id: 1, pad: 'b'.repeat(Number(padLen)) })
const sleep = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
// 源腿自己走原子替换：本用例只审"镜像写 dst"这条腿，别让源侧半写混进来（那是假红）。
// Windows 上隔壁写进程 mirror() 里的 readFileSync(src) 同样会咬住 rename ⇒ 这条腿也要重试。
const put = (p, buf) => {
  const tmp = p + '.tmp.' + process.pid
  for (let i = 0; ; i++) {
    writeFileSync(tmp, buf)
    try { renameSync(tmp, p); return }
    catch (e) { if (i >= 300) throw e; sleep() }
  }
}
// 逐轮翻面 ⇒ 稳态零写不成立，写入腿真被压到。
for (let i = 0; i < Number(iters); i++) {
  for (const f of files) put(join(javaFlows, f), i % 2 ? B : A)
  mirror(root)
}
`,
    )
    writeFileSync(
      join(readerDir, 'reader.mjs'),
      `import { readFileSync } from 'node:fs'
const [dir, filesArg, dur] = process.argv.slice(2)
const files = filesArg.split(',')
const sleep = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1)
const t0 = Date.now()
let ok = 0, torn = 0
const samples = []
// 像真实测试那样消费：每轮挑一份读一次、留一点间隙（不是死盯一份文件不放句柄）
while (Date.now() - t0 < Number(dur)) {
  const f = files[Math.floor(Math.random() * files.length)]
  try { JSON.parse(readFileSync(dir + '/' + f, 'utf8')); ok++ }
  catch (e) { torn++; if (samples.length < 2) samples.push(f + ': ' + String(e.message).slice(0, 60)) }
  sleep()
}
process.stdout.write(JSON.stringify({ ok, torn, samples }))
`,
    )

    const ws = [0, 1].map(() => child(join(proj, 'writer.mjs'), [proj, javaFlows, '6', String(PAD), FILES.join(',')]))
    const rs = [0, 1, 2].map(
      () =>
        new Promise<string>((resolve, reject) => {
          const p = spawn(process.execPath, [join(readerDir, 'reader.mjs'), join(proj, 'flows'), FILES.join(','), '2500'])
          let out = ''
          p.stdout.on('data', (d) => (out += d))
          p.stderr.on('data', (d) => (out += d))
          p.on('error', reject)
          p.on('close', () => resolve(out))
        }),
    )
    const [results, readers] = [await Promise.all(ws), await Promise.all(rs)]

    assert.deepEqual(
      results.map((r) => r.code),
      [0, 0],
      `写进程应正常退出（镜像失败不许静默）：${results.map((r) => r.err.slice(0, 300)).join(' | ')}`,
    )
    const parsed = readers.map((r) => JSON.parse(r || '{}'))
    const totalOk = parsed.reduce((s: number, j: any) => s + (j.ok || 0), 0)
    const totalTorn = parsed.reduce((s: number, j: any) => s + (j.torn || 0), 0)
    assert.ok(totalOk > 100, `读者得真读到足够多次才构成判据（实读 ok=${totalOk}）`)
    assert.equal(totalTorn, 0, `半写读数：${readers.join(' / ')}`)
  } finally {
    rmSync(readerDir, { recursive: true, force: true })
    cleanup()
  }
})

test('i187 镜像失败上抛不吞、不留孤儿临时件', () => {
  const { proj, javaFlows, cleanup } = makeTree()
  try {
    writeFileSync(join(javaFlows, '01-a.json'), body('c', 64))
    mkdirSync(join(proj, 'flows', '01-a.json')) // 目标名被目录占位 ⇒ 写入必失败
    assert.throws(() => mirror(proj), '镜像失败必须抛出，不能静默丢夹具')
    assert.deepEqual(readdirSync(join(proj, 'flows')).filter((f) => f.includes('.tmp.')), [], '抛出前应清掉自己的临时件')
  } finally {
    cleanup()
  }
})
