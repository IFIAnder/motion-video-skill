#!/usr/bin/env node
/**
 * render.mjs — 帧精确、可复现的 HTML 动画渲染器（零 npm 依赖）
 *
 * 输入：一个单文件 HTML 场景（遵守下方契约）
 * 输出：PNG 帧序列 + mp4 / webm / gif / webp / 接触表
 *
 * 为什么不用 recordVideo / 屏幕录制：
 *   屏幕录制是"实时"的，帧率取决于机器负载，掉帧、撕裂、结果不可复现，
 *   而且无法只渲某一段、无法保证 t=1.500s 的那一帧一定是同一个像素。
 *   这里用"时间轴外置"：渲染器逐帧调用 scene.seek(t) 再截图，
 *   所以同一份 HTML 在任何机器上产出的每一帧字节级一致。这是让产物可被机器验收的前提。
 *
 * 页面契约（HTML 内必须实现，全部内联，勿依赖外部网络资源）：
 *   window.scene = {
 *     duration: 3.0,            // 秒，必填
 *     fps: 30,                  // 可选，默认 30
 *     width: 1920, height: 1080,// 可选，默认 1920x1080
 *     ready: true,              // 可选，布尔或 Promise（字体/图片加载完成）
 *     seek(t) { ... }           // 必填：把画面切换到时刻 t（秒）的状态，必须是纯函数
 *   }
 *
 * 用法：
 *   node render.mjs --html scene.html --out out/demo.mp4
 *   node render.mjs --html scene.html --still 0,0.5,1.2 --out out/stills   # 只出关键帧，审图用
 *   node render.mjs --html scene.html --format gif --fps 20 --sheet
 *   node render.mjs --check                                                # 只体检环境
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2)
// fps 默认留空：让 scene.fps 有机会生效（曾经写死 30，导致场景里声明 fps:15 仍按 30 渲，
// 随后 audit --fps 15 把整条时间轴标错一倍）。最终取值 = --fps || scene.fps || 30。
const opt = { fps: undefined, scale: 1, format: 'mp4', sheet: false, alpha: false, serve: true, guides: false, motionBlur: 0 }
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  const val = () => {
    const v = argv[++i]
    if (v === undefined) die(`参数 ${a} 缺少取值`)
    return v
  }
  switch (a) {
    case '--html': opt.html = val(); break
    case '--out': opt.out = val(); break
    case '--fps': opt.fps = Number(val()); break
    case '--duration': opt.duration = Number(val()); break
    case '--width': opt.width = Number(val()); break
    case '--height': opt.height = Number(val()); break
    case '--scale': opt.scale = Number(val()); break
    case '--format': opt.format = val(); break
    case '--still': opt.still = val(); break
    case '--guides': opt.guides = true; break
    case '--motion-blur': opt.motionBlur = Number(val()); break
    case '--allow-concurrent': opt.allowConcurrent = true; break
    case '--sheet': opt.sheet = true; break
    case '--alpha': opt.alpha = true; break
    case '--file': opt.serve = false; break
    case '--chrome': opt.chrome = val(); break
    case '--keep-frames': opt.keepFrames = true; break
    case '--check': opt.check = true; break
    case '--quiet': opt.quiet = true; break
    case '-h': case '--help': printHelp(); process.exit(0)
    default: die(`未知参数 ${a}（--help 查看用法）`)
  }
}

function printHelp() {
  console.log(`render.mjs — 帧精确 HTML 动画渲染器

  --html <file>       场景 HTML（必填，除非 --check）
  --out <path>        输出文件或目录，默认 out/render.<format>
  --fps <n>           帧率；优先级 --fps > scene.fps > 30
  --duration <sec>    覆盖 scene.duration
  --width/--height    覆盖 scene.width/height，默认 1920x1080
  --scale <n>         设备像素比，默认 1（2 = 2x 超采样，更清晰更慢）
  --format <fmt>      mp4 | webm | gif | webp | apng | png，默认 mp4
  --still <t1,t2,..>  只渲染指定时刻（秒），输出 PNG，审图用，最快
  --guides            叠加构图辅助线（网格 / 80px 安全区 / 三分线 / 中心十字），只对 --still 生效
  --motion-blur <deg> 运动模糊（快门角度）。180 = 电影标准，360 = 满快门更糊，0 = 关闭（默认）
                      内部以 4 倍帧率渲染再按曝光窗平均，渲染时间 ×4
  --sheet             额外产出 3x3 接触表 PNG
  --alpha             透明背景。webp / apng / png 可靠；webm 取决于 ffmpeg 构建
                      （本机实测 VP8/VP9 都会降级成无 alpha，脚本会在编码后回读校验并报错）
  --file              用 file:// 加载（默认起临时静态服务器，对 ES module 友好）
  --keep-frames       保留 PNG 帧序列
  --chrome <path>     指定浏览器可执行文件
  --check             只做环境体检
  --quiet             安静模式`)
}

function die(msg) {
  console.error('✖ ' + msg)
  process.exit(1)
}
const log = (...a) => { if (!opt.quiet) console.log(...a) }

// ---------------------------------------------------------------- env

function findChrome() {
  const cands = [
    opt.chrome,
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ].filter(Boolean)
  for (const c of cands) if (existsSync(c)) return c
  return null
}

function findFfmpeg() {
  const cands = [
    process.env.FFMPEG_PATH,
    'ffmpeg',
    'D:/FFmpeg/ffmpeg.exe',
    'C:/ffmpeg/bin/ffmpeg.exe',
    '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg',
  ].filter(Boolean)
  for (const c of cands) {
    if (c === 'ffmpeg') return c    // 交给 PATH
    if (existsSync(c)) return c
  }
  return 'ffmpeg'
}

if (opt.check) {
  const chrome = findChrome()
  const ff = findFfmpeg()
  const probe = await run(ff, ['-version'], { silent: true }).catch(() => null)
  console.log(JSON.stringify({
    chrome: chrome || 'NOT FOUND',
    ffmpeg: ff,
    ffmpegOk: !!(probe && probe.code === 0),
    node: process.version,
    webSocket: typeof WebSocket,
    cwd: process.cwd(),
  }, null, 2))
  process.exit(chrome ? 0 : 1)
}

if (!opt.html) die('缺少 --html（或 --check 体检）')
if (!existsSync(opt.html)) die(`找不到 HTML：${opt.html}`)

// ---- 单实例锁：并发起多个 Chrome 会互相抢 CPU，实际比串行更慢 ----
// （实测：一个 4 并发 × 4 倍子帧的任务，CPU 全被 swiftshader 软件渲染吃掉，
//   单进程跑完反而更快。真要并行就在一个 Chrome 里开多个 tab，见 cinema-grade.md §9）
if (!opt.allowConcurrent) {
  const lockFile = path.join(os.tmpdir(), 'motion-video-render.lock')
  let holder = null
  try {
    holder = JSON.parse(await readFile(lockFile, 'utf8'))
  } catch { /* 没有锁 */ }
  if (holder) {
    let alive = false
    try { process.kill(holder.pid, 0); alive = true } catch { alive = false }
    if (alive) {
      die(`已有渲染进程在跑（pid ${holder.pid}，起于 ${holder.at}，来源 ${holder.html || '?'}）。
  并发起多个 Chrome 只会互相抢 CPU，串行通常更快。
  确实要并发就加 --allow-concurrent，或者改成一个进程内多 tab（见 references/cinema-grade.md §9）。`)
    }
  }
  await writeFile(lockFile, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), html: path.resolve(opt.html) }))
  const release = () => { try { rm(lockFile, { force: true }) } catch {} }
  process.on('exit', release)
  process.on('SIGINT', () => { release(); process.exit(130) })
}

// ---------------------------------------------------------------- proc helpers

function run(cmd, args, { silent = false } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true })
    let out = '', err = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('error', (e) => resolve({ code: -1, out, err: err + e.message }))
    p.on('close', (code) => {
      if (!silent && code !== 0) console.error(err.split('\n').slice(-8).join('\n'))
      resolve({ code, out, err })
    })
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 二进制 stdout 版本：alpha 校验要读原始像素，用字符串收集会把字节弄坏
function runBin(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true })
    const bufs = []
    let err = ''
    p.stdout.on('data', (d) => bufs.push(d))
    p.stderr.on('data', (d) => { err += d })
    p.on('error', (e) => resolve({ code: -1, buf: Buffer.alloc(0), err: err + e.message }))
    p.on('close', (code) => resolve({ code, buf: Buffer.concat(bufs), err }))
  })
}

// ---------------------------------------------------------------- static server

async function startServer(rootDir) {
  const types = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
    '.webp': 'image/webp', '.woff2': 'font/woff2', '.woff': 'font/woff',
    '.ttf': 'font/ttf', '.mp4': 'video/mp4', '.webm': 'video/webm',
  }
  const server = createServer(async (req, res) => {
    try {
      const url = decodeURIComponent((req.url || '/').split('?')[0])
      const rel = url === '/' ? '/index.html' : url
      const full = path.join(rootDir, rel)
      if (!full.startsWith(rootDir)) { res.writeHead(403).end(); return }
      const body = await readFile(full)
      res.writeHead(200, { 'Content-Type': types[path.extname(full).toLowerCase()] || 'application/octet-stream' })
      res.end(body)
    } catch {
      res.writeHead(404).end('not found')
    }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, port: server.address().port }
}

// ---------------------------------------------------------------- CDP

class CDP {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    this.handlers = new Map()
    ws.addEventListener('message', (ev) => {
      let msg
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')) } catch { return }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (timer) clearTimeout(timer)
        msg.error ? reject(new Error(`${msg.error.message}${msg.error.data ? ' — ' + msg.error.data : ''}`)) : resolve(msg.result)
      } else if (msg.method) {
        for (const fn of this.handlers.get(msg.method) || []) fn(msg.params)
      }
    })
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, [])
    this.handlers.get(method).push(fn)
  }
  send(method, params = {}) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP 超时：${method}`)) }
      }, 120000)
      if (timer.unref) timer.unref()
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async evaluate(expression, { awaitPromise = false } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise, userGesture: true,
    })
    if (r.exceptionDetails) {
      const d = r.exceptionDetails
      throw new Error(`页面脚本报错：${d.exception?.description || d.text}`)
    }
    return r.result?.value
  }
  close() { try { this.ws.close() } catch {} }
}

async function launchChrome(chromePath) {
  // 顺手清掉上次异常退出留下的 profile（后台删除没删完的），避免 %TEMP% 涨大
  const tmpRoot = os.tmpdir()
  readdir(tmpRoot).then((names) => {
    const cutoff = Date.now() - 24 * 3600 * 1000
    for (const n of names) {
      if (!n.startsWith('motion-video-')) continue
      const full = path.join(tmpRoot, n)
      stat(full).then((s) => { if (s.mtimeMs < cutoff) rm(full, { recursive: true, force: true }).catch(() => {}) }).catch(() => {})
    }
  }).catch(() => {})

  const userDir = path.join(os.tmpdir(), `motion-video-${process.pid}-${Date.now()}`)
  await mkdir(userDir, { recursive: true })
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--hide-scrollbars',
    '--force-color-profile=srgb',
    '--font-render-hinting=none',
    '--allow-file-access-from-files',
    '--use-angle=swiftshader',      // 让 canvas / WebGL 在无 GPU 环境也能确定性出图
    '--enable-unsafe-swiftshader',
    '--mute-audio',
    'about:blank',
  ]
  const proc = spawn(chromePath, args, { windowsHide: true, stdio: 'ignore' })
  const portFile = path.join(userDir, 'DevToolsActivePort')
  let portTxt = null
  for (let i = 0; i < 200; i++) {
    await sleep(50)
    try { portTxt = await readFile(portFile, 'utf8'); break } catch {}
    if (proc.exitCode !== null) break
  }
  if (!portTxt) {
    try { proc.kill() } catch {}
    throw new Error('浏览器没有开启调试端口（检查 chrome 路径 / 权限）')
  }
  const port = Number(portTxt.split(/\r?\n/)[0])
  let wsUrl = null
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = list.find((t) => t.type === 'page')
      if (page?.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break }
    } catch {}
    await sleep(100)
  }
  if (!wsUrl) { try { proc.kill() } catch {}; throw new Error('连不上浏览器调试端点') }
  return {
    proc, userDir,
    async connect() {
      const ws = new WebSocket(wsUrl)
      await new Promise((res, rej) => {
        ws.addEventListener('open', res, { once: true })
        ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true })
        setTimeout(() => rej(new Error('WebSocket 连接超时')), 15000)
      })
      return new CDP(ws)
    },
    async dispose() {
      // Windows 下 Chrome 是一棵进程树，proc.kill() 只杀主进程，会留下 GPU/渲染子进程拖住退出
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        } else {
          proc.kill('SIGKILL')
        }
      } catch { try { proc.kill() } catch {} }
      await sleep(150)
      // 临时 profile 有上千个小文件，在 Windows 上同步删要十几秒（杀软逐个扫）。
      // 不能让清理拖住收尾：后台删，删不完留给下次启动的 stale 清理。
      rm(userDir, { recursive: true, force: true }).catch(() => {})
    },
  }
}

// ---------------------------------------------------------------- main

const chromePath = findChrome()
if (!chromePath) die('找不到 Chrome/Edge。用 --chrome <path> 指定，或安装其一。')
const ffmpeg = findFfmpeg()

const htmlAbs = path.resolve(opt.html)
const rootDir = path.dirname(htmlAbs)
let serverInfo = null
if (opt.serve) serverInfo = await startServer(rootDir)

const browser = await launchChrome(chromePath)
const cdp = await browser.connect()

try {
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')

  const url = serverInfo
    ? `http://127.0.0.1:${serverInfo.port}/${encodeURIComponent(path.basename(htmlAbs))}`
    : 'file:///' + htmlAbs.replace(/\\/g, '/')

  const loaded = new Promise((res) => cdp.on('Page.loadEventFired', res))
  await cdp.send('Page.navigate', { url })
  await Promise.race([loaded, sleep(15000)])

  // 等页面 own 的 ready（字体 / 图片 / 依赖）
  await cdp.evaluate(`(async () => {
    if (document.fonts && document.fonts.ready) { try { await document.fonts.ready } catch (e) {} }
    const S = window.scene;
    if (S && S.ready && typeof S.ready.then === 'function') { try { await S.ready } catch (e) {} }
    return true;
  })()`, { awaitPromise: true })

  const meta = await cdp.evaluate(`(() => {
    const S = window.scene;
    if (!S) return { error: 'window.scene 未定义' };
    return {
      duration: S.duration, fps: S.fps, width: S.width, height: S.height,
      hasSeek: typeof S.seek === 'function',
    };
  })()`)
  if (meta.error) die(`${meta.error}（页面必须暴露 window.scene = { duration, seek(t) }）`)
  if (!meta.hasSeek) die('scene.seek(t) 未实现，渲染器无法逐帧驱动')

  const W = Math.round(opt.width || meta.width || 1920)
  const H = Math.round(opt.height || meta.height || 1080)
  const FPS = Number(opt.fps || meta.fps || 30)
  if (!Number.isFinite(FPS) || FPS <= 0) {
    die(`帧率无效：${opt.fps ?? meta.fps}（--fps 要给正数；scene.fps 也必须是正数）`)
  }
  if (!opt.fps && meta.fps) log(`  帧率取自 scene.fps = ${meta.fps}`)
  const DUR = Number(opt.duration || meta.duration)
  if (!DUR || DUR <= 0) die('拿不到时长：给 --duration 或让 scene.duration 有值')

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: Number(opt.scale) || 1, mobile: false,
  })
  if (opt.alpha) {
    await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } })
  }

  const fmt = opt.format.toLowerCase()
  const outPath = path.resolve(opt.out || path.join('out', `render.${fmt === 'png' ? 'mp4' : fmt}`))
  const outDir = path.dirname(outPath)
  const framesDir = path.join(outDir, `frames-${path.basename(outPath, path.extname(outPath))}`)
  await mkdir(framesDir, { recursive: true })

  const seekScript = (t) => `(() => {
    const S = window.scene;
    const t = ${Number(t)};
    S.seek(t);
    if (document.getAnimations) {
      for (const a of document.getAnimations()) {
        try { a.pause(); a.currentTime = t * 1000; } catch (e) {}
      }
    }
    if (window.__syncVideo) { try { window.__syncVideo(t) } catch (e) {} }
    return true;
  })()`

  const shot = async (file) => {
    const r = await cdp.send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: false, fromSurface: true, optimizeForSpeed: true,
    })
    await writeFile(file, Buffer.from(r.data, 'base64'))
  }

  const t0 = Date.now()
  let produced = []

  // 构图辅助线：只用于审图的关键帧，不进成片。帮模型自己判断版面，
  // 它看不出"重心偏了"，但能看出"标题压过安全区了"。
  const GUIDES = `(() => {
    if (document.getElementById('__mv_guides')) return true;
    const W = innerWidth, H = innerHeight;
    const d = document.createElement('div');
    d.id = '__mv_guides';
    d.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
    const mk = (css) => { const e = document.createElement('div'); e.style.cssText = css; return e };
    d.append(
      mk('position:absolute;inset:0;background-image:linear-gradient(rgba(0,255,200,.14) 1px,transparent 1px),linear-gradient(90deg,rgba(0,255,200,.14) 1px,transparent 1px);background-size:100px 100px'),
      mk('position:absolute;left:80px;right:80px;top:80px;bottom:80px;border:2px dashed rgba(255,70,120,.85)'),
      mk('position:absolute;left:' + (W/3) + 'px;top:0;bottom:0;width:1px;background:rgba(255,220,0,.35)'),
      mk('position:absolute;left:' + (W*2/3) + 'px;top:0;bottom:0;width:1px;background:rgba(255,220,0,.35)'),
      mk('position:absolute;top:' + (H/3) + 'px;left:0;right:0;height:1px;background:rgba(255,220,0,.35)'),
      mk('position:absolute;top:' + (H*2/3) + 'px;left:0;right:0;height:1px;background:rgba(255,220,0,.35)'),
      mk('position:absolute;left:' + (W/2) + 'px;top:0;bottom:0;width:1px;background:rgba(255,255,255,.45)'),
      mk('position:absolute;top:' + (H/2) + 'px;left:0;right:0;height:1px;background:rgba(255,255,255,.45)'),
    );
    document.body.appendChild(d);
    return true;
  })()`

  if (opt.still) {
    const times = opt.still.split(',').map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n))
    if (!times.length) die('--still 需要逗号分隔的秒数，例如 0,0.5,1.2')
    const stillDir = outPath.endsWith('.png') ? path.dirname(outPath) : outPath
    await mkdir(stillDir, { recursive: true })
    for (const t of times) {
      await cdp.evaluate(seekScript(t))
      if (opt.guides) await cdp.evaluate(GUIDES)
      const f = path.join(stillDir, `still-${String(t.toFixed(3)).replace('.', '_')}${opt.guides ? '-guides' : ''}.png`)
      await shot(f)
      produced.push(f)
      log(`  关键帧 t=${t}s -> ${path.relative(process.cwd(), f)}`)
    }
    console.log(JSON.stringify({ ok: true, mode: 'still', guides: opt.guides, files: produced, ms: Date.now() - t0 }, null, 2))
  } else {
    if (opt.guides) log('  提示：--guides 只对 --still 生效，成片里不叠辅助线')

    // ---- 运动模糊：以 SUB 倍帧率渲染，再按曝光窗在 ffmpeg 里做时间平均 ----
    // 快门角度 deg 对应的曝光 = (deg/360)/FPS 秒。以 FPS*SUB 采样后，
    // 一次曝光覆盖 SUB*(deg/360) 个子帧 —— 平均这几个子帧就是真实的运动模糊。
    // 这正是"同样的动效为什么别人的看起来更顺"的一半原因：不是更会画，是有快门。
    const SUB = opt.motionBlur > 0 ? 4 : 1
    const RENDER_FPS = FPS * SUB
    const mixFrames = opt.motionBlur > 0 ? Math.max(1, Math.round(SUB * opt.motionBlur / 360)) : 1
    const total = Math.max(1, Math.round(DUR * RENDER_FPS))
    for (let i = 0; i < total; i++) {
      const t = i / RENDER_FPS
      await cdp.evaluate(seekScript(t))
      const f = path.join(framesDir, `f${String(i).padStart(5, '0')}.png`)
      await shot(f)
      produced.push(f)
      if (!opt.quiet && (i === 0 || (i + 1) % Math.max(15, Math.round(RENDER_FPS / 2)) === 0 || i === total - 1)) {
        log(`  渲染 ${i + 1}/${total} 帧 (t=${t.toFixed(2)}s)`)
      }
    }
    log(`  帧序列完成：${total} 帧 @ ${RENDER_FPS}fps，${((Date.now() - t0) / 1000).toFixed(1)}s`)

    const blurVf = SUB > 1
      ? `tmix=frames=${mixFrames},select='not(mod(n\\,${SUB}))',setpts=N/(${FPS}*TB)`
      : null
    const seqIn = ['-framerate', String(RENDER_FPS), '-i', path.join(framesDir, 'f%05d.png')]
    const encode = async (args, target) => {
      const r = await run(ffmpeg, ['-y', '-v', 'error', ...args, target], { silent: true })
      if (r.code !== 0) throw new Error(`ffmpeg 失败：${r.err.split('\n').slice(-4).join(' ')}`)
      return target
    }

    // --alpha 的验收：编码后回读首帧，alpha 必须真的有 0。
    // 实测本机 ffmpeg（9.x gyan full build）把 yuva420p 静默降级成 yuv420p：
    // VP8 和 VP9 出的 webm 看着正常，alpha 全是 255。这种静默降级必须当场抓住，
    // 否则交付的是"自己看着透明、叠到背景上才发现是个不透明色块"的文件。
    const assertAlpha = async (file, name) => {
      const r = await runBin(ffmpeg, ['-y', '-v', 'error', '-i', file,
        '-frames:v', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', '-'])
      if (r.code !== 0 || r.buf.length < 4) return
      let zeros = 0
      for (let i = 3; i < r.buf.length; i += 4) if (r.buf[i] === 0) zeros++
      if (zeros === 0) {
        die(
          `--alpha 没有生效：${name} 的 alpha 全是 255（${r.buf.length / 4} 个像素里没有一个透明）。\n` +
          `  不是参数写错，是当前 ffmpeg 不给 ${name} 写 alpha 通道。\n` +
          `  实测本机 ${ffmpeg} 对 VP8/VP9 的 yuva420p 一律降级成 yuv420p。\n` +
          `  可用替代：--format webp（动画 WebP，带 alpha）｜--format apng（带 alpha）｜--format png（透明序列）\n` +
          `  坚持要 webm 就得换一个带 libvpx alpha 支持的 ffmpeg 构建。`
        )
      }
      log(`  alpha 校验通过：${name} 含 ${zeros} 个透明像素`)
    }

    // 有模糊时所有格式都先统一降帧（blurVf 已包含 select 与 setpts）
    if (fmt === 'mp4') {
      if (opt.alpha) log('  提示：mp4/H.264 不支持 alpha，--alpha 无效（要透明用 webp / apng / png）')
      await encode([...seqIn, ...(blurVf ? ['-vf', blurVf, '-r', String(FPS)] : []),
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '17',
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart'], outPath)
    } else if (fmt === 'webm') {
      await encode([...seqIn, ...(blurVf ? ['-vf', blurVf, '-r', String(FPS)] : []),
        '-c:v', 'libvpx-vp9', '-crf', '28', '-b:v', '0',
        ...(opt.alpha ? ['-pix_fmt', 'yuva420p', '-auto-alt-ref', '0'] : []), '-row-mt', '1'], outPath)
      if (opt.alpha) await assertAlpha(outPath, 'webm')
    } else if (fmt === 'gif') {
      const pal = path.join(outDir, '.palette.png')
      const gf = `fps=${Math.min(FPS, 25)},scale=${Math.min(W, 960)}:-1:flags=lanczos`
      await encode([...seqIn, ...(blurVf ? ['-vf', blurVf] : []),
        '-vf', `${blurVf ? blurVf + ',' : ''}${gf},palettegen=max_colors=192`, '-frames:v', '1'], pal)
      await encode([...seqIn, ...(blurVf ? ['-vf', blurVf] : []), '-i', pal, '-lavfi',
        `${blurVf ? blurVf + ',' : ''}${gf} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=3`], outPath)
      try { await rm(pal, { force: true }) } catch {}
    } else if (fmt === 'webp') {
      // 原写法带了第二个 -vf，会把 blurVf 整个覆盖掉（开了运动模糊却出无模糊的 webp）
      await encode([...seqIn,
        '-vf', `${blurVf ? blurVf + ',' : ''}fps=${FPS}`,
        '-loop', '0', '-c:v', 'libwebp_anim',
        ...(opt.alpha ? ['-pix_fmt', 'rgba'] : []), '-quality', '82'], outPath)
      if (opt.alpha) await assertAlpha(outPath, 'webp')
    } else if (fmt === 'apng') {
      await encode([...seqIn, ...(blurVf ? ['-vf', blurVf, '-r', String(FPS)] : []),
        '-c:v', 'apng', '-pix_fmt', 'rgba', '-plays', '0'], outPath)
      if (opt.alpha) await assertAlpha(outPath, 'apng')
    } else if (fmt === 'png') {
      // 只出序列 = 已产出，原样保留（此时序列是 RENDER_FPS，含子帧）
    } else {
      die(`不支持的 --format ${fmt}`)
    }

    let sheetPath = null
    {
      const cols = 3
      const count = 9
      const rows = Math.ceil(count / cols)
      const step = Math.max(1, Math.floor(total / count))
      const picked = Math.min(count, Math.ceil(total / step))
      sheetPath = path.join(outDir, `${path.basename(outPath, path.extname(outPath))}-sheet.png`)
      const r = await run(ffmpeg, ['-y', '-v', 'error', '-framerate', String(RENDER_FPS),
        '-i', path.join(framesDir, 'f%05d.png'),
        '-vf', `select='not(mod(n\\,${step}))',scale=560:-1:flags=lanczos,tile=${cols}x${Math.max(1, Math.ceil(picked / cols))}`,
        '-frames:v', '1', '-fps_mode', 'passthrough', sheetPath], { silent: true })
      if (r.code !== 0) sheetPath = null
    }

    if (!opt.keepFrames && fmt !== 'png') {
      try { await rm(framesDir, { recursive: true, force: true }) } catch {}
    }

    const sz = existsSync(outPath) ? (await stat(outPath)).size : 0
    console.log(JSON.stringify({
      ok: true, video: outPath, sheet: sheetPath, frames: total, fps: FPS,
      renderFps: RENDER_FPS, motionBlur: opt.motionBlur || 0, blurMix: mixFrames,
      duration: DUR, size: `${W}x${H}`, bytes: sz,
      next: `node audit.mjs --video "${outPath}" --fps ${FPS} --duration ${DUR} --width ${W} --height ${H}`,
    }, null, 2))
  }
} finally {
  cdp.close()
  await browser.dispose()
  if (serverInfo) serverInfo.server.close()
}
