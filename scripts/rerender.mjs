#!/usr/bin/env node
/**
 * rerender.mjs — 只重渲"内容真的变了"的场景。
 *
 * 为什么存在这个脚本：一次真实的 60 秒片制作里，7 个场景被完整重渲了 3 遍
 * （另加 1 遍 5 场景），累计 80.9 分钟，占全程 142 分钟的 57%，而其中三次
 * 只是为了确认一两处改动。人会嫌麻烦直接全渲，所以这件事必须由脚本替人做。
 *
 * 用法：
 *   node rerender.mjs --dir scenes --out out                 # 只渲变过的
 *   node rerender.mjs --dir scenes --out out --list          # 只列出会渲哪些（不渲染）
 *   node rerender.mjs --dir scenes --out out --force         # 忽略缓存全渲
 *   node rerender.mjs --dir scenes --out out --fps 30 --jobs 4 -- -gl auto
 *
 * 缓存键 = 场景 HTML + 它依赖的所有本地文件（js/css/html）的内容哈希。
 * 改了共享的 rbx.js，所有 import 它的场景都会重渲；只改 s3.html，就只有 s3 重渲。
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const RENDER = path.join(HERE, 'render.mjs')

const opt = { dir: 'scenes', out: 'out', jobs: 4, list: false, force: false, fps: null, duration: null, pattern: '.html', extra: [] }
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  const val = () => { const v = argv[++i]; if (v === undefined) die(`${a} 缺少取值`); return v }
  switch (a) {
    case '--dir': opt.dir = val(); break
    case '--out': opt.out = val(); break
    case '--jobs': opt.jobs = Number(val()) || 4; break
    case '--pattern': opt.pattern = val(); break
    case '--fps': opt.fps = val(); break
    case '--duration': opt.duration = val(); break
    case '--list': opt.list = true; break
    case '--force': opt.force = true; break
    case '--': opt.extra = argv.slice(i + 1); i = argv.length; break
    case '-h': case '--help': help(); process.exit(0)
    default: die(`未知参数 ${a}`)
  }
}

function die(m) { console.error(`\n  ✗ ${m}\n`); process.exit(1) }
function help() {
  console.log(`
  node rerender.mjs --dir <场景目录> --out <输出目录> [选项]

  --dir <d>         场景目录（默认 scenes）
  --out <d>         输出目录（默认 out），缓存写在 <out>/.motion-cache.json
  --pattern <.html> 场景文件后缀（默认 .html）
  --jobs <n>        每个场景内部并行 tab 数（默认 4，透传给 render.mjs）
  --fps <n>         ／--duration <s>  透传给 render.mjs
  --list            只打印"会渲哪些 / 跳过哪些"，不真的渲染
  --force           忽略缓存，全部重渲
  -- <args...>      原样透传给 render.mjs 的其他参数（如 -- --gl swift）

  判据：改哪个场景就只剩那个场景要渲；改了被多个场景共享的文件，
  所有依赖它的场景一起重渲 —— 这正是你想要的，也是你不想手算的。
`)
}

// ---------------------------------------------------------------- 依赖闭包
// 只往里递归"文本类"依赖。图片/字体按文件名参与哈希就够（内容变了文件名通常也变，
// 且图片改内容不改名的情况极少，真遇到就 --force）。
const TEXT_EXT = new Set(['.html', '.htm', '.js', '.mjs', '.css'])
const REF_RE = /(?:src|href)\s*=\s*["']([^"'#?]+)["']|(?:from|import)\s+["']([^"']+)["']/g

async function collectDeps(entry, seen) {
  const abs = path.resolve(entry)
  if (seen.has(abs)) return
  seen.add(abs)
  if (!TEXT_EXT.has(path.extname(abs).toLowerCase())) return
  let txt
  try { txt = await readFile(abs, 'utf8') } catch { return }
  REF_RE.lastIndex = 0
  let m
  while ((m = REF_RE.exec(txt))) {
    const ref = m[1] || m[2]
    if (!ref) continue
    if (/^(https?:)?\/\//.test(ref) || ref.startsWith('data:') || ref.startsWith('blob:')) continue
    const target = path.resolve(path.dirname(abs), ref)
    if (!existsSync(target)) continue
    await collectDeps(target, seen)
  }
}

async function hashScene(entry, rootForHash) {
  const seen = new Set()
  await collectDeps(entry, seen)
  const files = [...seen].sort()
  const h = createHash('sha256')
  for (const f of files) {
    // 哈希里只允许出现"相对于场景根"的路径。曾经用过 process.cwd()，
    // 结果从不同目录启动时同一个场景算出不同的 hash，缓存永远不命中。
    h.update(path.relative(rootForHash, f).replace(/\\/g, '/'))
    h.update('\0')
    try {
      h.update(await readFile(f))
    } catch { h.update('missing') }
    h.update('\0')
  }
  return { hash: h.digest('hex').slice(0, 16), files: files.length }
}

// ---------------------------------------------------------------- 主流程
const scenesDir = path.resolve(opt.dir)
if (!existsSync(scenesDir)) die(`场景目录不存在：${opt.dir}`)

const names = (await readdir(scenesDir))
  .filter((n) => n.toLowerCase().endsWith(opt.pattern.toLowerCase()))
  .sort()
if (!names.length) die(`${opt.dir} 里没有 *${opt.pattern}`)

const outDir = path.resolve(opt.out)
await mkdir(outDir, { recursive: true })
const cacheFile = path.join(outDir, '.motion-cache.json')
let cache = {}
try { cache = JSON.parse(await readFile(cacheFile, 'utf8')) } catch {}

const plan = []
const rootForHash = path.dirname(scenesDir)
for (const n of names) {
  const entry = path.join(scenesDir, n)
  const { hash, files } = await hashScene(entry, rootForHash)
  const base = path.basename(n, path.extname(n))
  const mp4 = path.join(outDir, `${base}.mp4`)
  const prev = cache[base]
  const upToDate = !opt.force && prev && prev.hash === hash && existsSync(mp4)
  plan.push({ name: n, base, entry, hash, files, mp4, skip: !!upToDate })
}

const todo = plan.filter((p) => !p.skip)
const skipped = plan.filter((p) => p.skip)

console.log(`\n  场景 ${plan.length} 个：要渲 ${todo.length}，跳过 ${skipped.length}${opt.force ? '（--force 全渲）' : ''}`)
for (const p of plan) {
  console.log(`   ${p.skip ? '跳过' : '渲染'}  ${p.name.padEnd(18)} ${p.hash}  (${p.files} 个依赖文件)`)
}
if (opt.list) {
  console.log('')
  process.exit(0)
}
if (!todo.length) {
  console.log('\n  全部是最新的，没有任何渲染。改共享文件（如 rbx.js）会连带重渲依赖它的场景。\n')
  process.exit(0)
}

// render.mjs 有单实例锁：批量必须在外面串行，靠每个进程内部的 --jobs 并行。
// 这也是刻意的——跨进程并发会互相抢 GPU 上下文，实测比串行更慢。
let failed = 0
for (const p of todo) {
  const args = [RENDER, '--html', p.entry, '--out', p.mp4, '--jobs', String(opt.jobs), ...opt.extra]
  if (opt.fps) args.push('--fps', String(opt.fps))
  if (opt.duration) args.push('--duration', String(opt.duration))
  const t0 = Date.now()
  const code = await new Promise((res) => {
    const c = spawn(process.execPath, args, { stdio: 'inherit', windowsHide: true })
    c.on('error', () => res(-1))
    c.on('close', res)
  })
  const sec = ((Date.now() - t0) / 1000).toFixed(1)
  if (code === 0) {
    cache[p.base] = { hash: p.hash, at: new Date().toISOString(), sec: Number(sec) }
    await writeFile(cacheFile, JSON.stringify(cache, null, 2))
    console.log(`  ✓ ${p.base}  ${sec}s`)
  } else {
    failed++
    console.log(`  ✗ ${p.base}  退出码 ${code}（${sec}s）—— 缓存没更新，下次还会重渲`)
  }
}

if (skipped.length) {
  console.log(`\n  这次省掉的渲染：${skipped.map((p) => p.base).join('、')}`)
  const saved = skipped.reduce((a, p) => a + (cache[p.base]?.sec || 0), 0)
  if (saved > 0) console.log(`  按上次记录，约省 ${(saved / 60).toFixed(1)} 分钟`)
}
console.log('')
process.exit(failed ? 1 : 0)
