#!/usr/bin/env node
/**
 * verify.mjs — 数值验算（比像素早一步，且能点名到元素）
 *
 * audit.mjs 说"1.10–2.57s 画面静止"。那是结果，不是原因。
 * verify 直接读每个元素在每个时刻的计算样式，于是能说：
 *   "#bar b 的 scaleX 在 t=1.60 之后锁定在 0.9998 —— easeOutExpo 在 k>0.9 已收敛"
 *   "#title 的 translateY 从头到尾没变 —— 那个 style 根本没被写进去"
 * 这是"多次验算"里最便宜的一层：纯数值，秒级，不用编码，还能顺手验证幂等性。
 *
 * 用法：
 *   node verify.mjs --html scene.html --select "#bar b" --props transform
 *   node verify.mjs --html scene.html --select "#title span,.dots i" --props transform,opacity --steps 61
 *   node verify.mjs --html scene.html --select ".item" --idempotent        # 检查 seek 是否幂等
 *   node verify.mjs --html scene.html --select "#n" --props opacity --json
 *
 * 参数：
 *   --html <file>        场景（必填）
 *   --select <css>       选择器，逗号分隔（默认 "[id]"）
 *   --props <list>       计算样式属性，逗号分隔，默认 transform,opacity
 *   --from/--to <sec>    区间，默认 0 到 scene.duration
 *   --steps <n>          采样点数，默认 61（均匀取，含两端）
 *   --idempotent         对每个采样点做 seek(t)→seek(0)→seek(t)，比较两次结果
 *   --json               机器可读
 *   --file               用 file:// 加载（默认起临时静态服务器）
 *   --chrome <path>      指定浏览器
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const argv = process.argv.slice(2)
const opt = {
  select: '[id]',
  props: 'transform,opacity,text',
  steps: 61,
  serve: true,
  idempotent: false,
  json: false,
}
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  const val = () => { const v = argv[++i]; if (v === undefined) { console.error(`✖ ${a} 缺少取值`); process.exit(1) } return v }
  switch (a) {
    case '--html': opt.html = val(); break
    case '--select': opt.select = val(); break
    case '--props': opt.props = val(); break
    case '--from': opt.from = Number(val()); break
    case '--to': opt.to = Number(val()); break
    case '--steps': opt.steps = Number(val()); break
    case '--idempotent': opt.idempotent = true; break
    case '--all': opt.all = true; break
    case '--json': opt.json = true; break
    case '--file': opt.serve = false; break
    case '--chrome': opt.chrome = val(); break
    case '-h': case '--help':
      console.log('用法: node verify.mjs --html scene.html [--select css] [--props a,b] [--from 0 --to 3 --steps 61] [--idempotent] [--json]')
      process.exit(0)
    default: console.error(`✖ 未知参数 ${a}`); process.exit(1)
  }
}
if (!opt.html) { console.error('✖ 缺少 --html'); process.exit(1) }
if (!existsSync(opt.html)) { console.error(`✖ 找不到 ${opt.html}`); process.exit(1) }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function findChrome() {
  const cands = [
    opt.chrome, process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium',
  ].filter(Boolean)
  return cands.find((c) => existsSync(c)) || null
}

async function startServer(rootDir) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }
  const server = createServer(async (req, res) => {
    try {
      const url = decodeURIComponent((req.url || '/').split('?')[0])
      const full = path.join(rootDir, url === '/' ? '/index.html' : url)
      if (!full.startsWith(rootDir)) { res.writeHead(403).end(); return }
      const body = await readFile(full)
      res.writeHead(200, { 'Content-Type': types[path.extname(full).toLowerCase()] || 'application/octet-stream' })
      res.end(body)
    } catch { res.writeHead(404).end('nf') }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, port: server.address().port }
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map()
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')) } catch { return }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject, timer } = this.pending.get(m.id)
        this.pending.delete(m.id); if (timer) clearTimeout(timer)
        m.error ? reject(new Error(m.error.message)) : resolve(m.result)
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP 超时 ${method}`)) } }, 120000)
      if (timer.unref) timer.unref()
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async evaluate(expression, { awaitPromise = false } = {}) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise, userGesture: true })
    if (r.exceptionDetails) throw new Error(`页面脚本报错：${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`)
    return r.result?.value
  }
  close() { try { this.ws.close() } catch {} }
}

const chrome = findChrome()
if (!chrome) { console.error('✖ 找不到 Chrome/Edge，用 --chrome <path> 指定'); process.exit(1) }

const htmlAbs = path.resolve(opt.html)
let serverInfo = null
if (opt.serve) serverInfo = await startServer(path.dirname(htmlAbs))

const userDir = path.join(os.tmpdir(), `motion-verify-${process.pid}-${Date.now()}`)
await mkdir(userDir, { recursive: true })
const proc = spawn(chrome, [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${userDir}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--hide-scrollbars', '--allow-file-access-from-files', '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', 'about:blank',
], { windowsHide: true, stdio: 'ignore' })

let cdp = null
try {
  let portTxt = null
  const portFile = path.join(userDir, 'DevToolsActivePort')
  for (let i = 0; i < 200; i++) {
    await sleep(50)
    try { portTxt = await readFile(portFile, 'utf8'); break } catch {}
    if (proc.exitCode !== null) break
  }
  if (!portTxt) throw new Error('浏览器没有开调试端口')
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
  if (!wsUrl) throw new Error('连不上调试端点')
  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', () => rej(new Error('WS 连接失败')), { once: true })
    setTimeout(() => rej(new Error('WS 连接超时')), 15000)
  })
  cdp = new CDP(ws)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')

  const nav = cdp.send('Page.navigate', {
    url: serverInfo ? `http://127.0.0.1:${serverInfo.port}/${encodeURIComponent(path.basename(htmlAbs))}`
      : 'file:///' + htmlAbs.replace(/\\/g, '/'),
  })
  await nav
  await sleep(300)

  await cdp.evaluate(`(async () => {
    if (document.fonts && document.fonts.ready) { try { await document.fonts.ready } catch(e){} }
    const S = window.scene;
    if (S && S.ready && typeof S.ready.then === 'function') { try { await S.ready } catch(e){} }
    return true;
  })()`, { awaitPromise: true })

  const meta = await cdp.evaluate(`(() => {
    const S = window.scene;
    return S ? { duration: S.duration, hasSeek: typeof S.seek === 'function' } : { error: 'window.scene 未定义' };
  })()`)
  if (meta.error) throw new Error(meta.error)
  if (!meta.hasSeek) throw new Error('scene.seek 未实现')

  const from = opt.from ?? 0
  const to = opt.to ?? meta.duration
  const steps = Math.max(2, opt.steps)
  const times = Array.from({ length: steps }, (_, i) => +(from + (to - from) * (i / (steps - 1))).toFixed(5))

  const PROPS = opt.props.split(',').map((s) => s.trim()).filter(Boolean)
  const selectors = opt.select.split(',').map((s) => s.trim()).filter(Boolean)

  // 每个采样点：seek(t) → 读出选中元素的计算样式
  const sample = (t) => cdp.evaluate(`(() => {
    window.scene.seek(${t});
    if (document.getAnimations) for (const a of document.getAnimations()) { try { a.pause(); a.currentTime = ${t} * 1000 } catch (e) {} }
    const sels = ${JSON.stringify(selectors)};
    const props = ${JSON.stringify(PROPS)};
    const out = [];
    for (const sel of sels) {
      const els = [...document.querySelectorAll(sel)].slice(0, 24);
      els.forEach((el, idx) => {
        const cs = getComputedStyle(el);
        const vals = {};
        for (const p of props) {
          // text 是伪属性：数字滚动、计数器变的是内容而不是样式，不查它就漏了
          vals[p] = (p === 'text') ? (el.textContent || '').trim() : cs.getPropertyValue(p);
        }
        out.push({ sel, idx, tag: el.tagName.toLowerCase(), id: el.id || '', cls: (el.className || '').toString().slice(0, 40), vals });
      });
    }
    return out;
  })()`)

  const num = (s) => { const m = String(s).match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/g); return m ? m.map(Number) : [] }

  // transform → 语义通道
  const parseProp = (prop, raw) => {
    if (!raw) return {}
    if (prop === 'transform' && /^matrix/.test(raw)) {
      const n = num(raw)
      if (n.length === 6) {
        const [a, b, c, d, e, f] = n
        return {
          tx: +e.toFixed(3),
          ty: +f.toFixed(3),
          sx: +Math.hypot(a, b).toFixed(4),
          sy: +Math.hypot(c, d).toFixed(4),
          rot: +(Math.atan2(b, a) * 180 / Math.PI).toFixed(2),
        }
      }
      if (n.length === 16) {
        const sx = Math.hypot(n[0], n[1]), sy = Math.hypot(n[4], n[5])
        return { tx: +n[12].toFixed(3), ty: +n[13].toFixed(3), sx: +sx.toFixed(4), sy: +sy.toFixed(4), rot: +(Math.atan2(n[1], n[0]) * 180 / Math.PI).toFixed(2) }
      }
      return {}
    }
    const n = num(raw)
    if (!n.length) return {}
    if (n.length === 1) return { [prop]: +n[0].toFixed(4) }
    return Object.fromEntries(n.map((v, i) => [`${prop}[${i}]`, +v.toFixed(3)]))
  }

  // 采样全部时刻
  const frames = []
  for (const t of times) frames.push({ t, items: await sample(t) })

  // 幂等性：seek(t) → seek(0) → seek(t)
  const idempotent = { checked: 0, mismatches: [] }
  if (opt.idempotent) {
    for (const t of times.filter((_, i) => i % Math.max(1, Math.floor(times.length / 12)) === 0 || i === times.length - 1)) {
      const a = await sample(t)
      await cdp.evaluate(`(() => { window.scene.seek(0); if (document.getAnimations) for (const an of document.getAnimations()) { try { an.pause(); an.currentTime = 0 } catch(e){} } return true })()`)
      const b = await sample(t)
      idempotent.checked++
      for (let i = 0; i < Math.min(a.length, b.length); i++) {
        for (const p of PROPS) {
          if (String(a[i].vals[p]) !== String(b[i].vals[p])) {
            idempotent.mismatches.push({
              t, sel: a[i].sel, idx: a[i].idx, prop: p,
              first: String(a[i].vals[p]).slice(0, 60), second: String(b[i].vals[p]).slice(0, 60),
            })
          }
        }
      }
    }
  }

  // 逐元素 × 逐通道分析
  const elementCount = frames[0]?.items.length || 0
  const report = []
  for (let k = 0; k < elementCount; k++) {
    const first = frames[0].items[k]
    const channels = {}
    for (const f of frames) {
      const it = f.items[k]
      if (!it) continue
      for (const p of PROPS) {
        const parsed = parseProp(p, it.vals[p])
        for (const [ch, v] of Object.entries(parsed)) {
          if (!channels[ch]) channels[ch] = []
          channels[ch].push({ t: f.t, v })
        }
      }
    }
    const chReport = {}
    for (const [ch, arr] of Object.entries(channels)) {
      if (!arr.length) continue
      const vs = arr.map((a) => a.v)
      const min = Math.min(...vs), max = Math.max(...vs)
      const span = +(max - min).toFixed(4)
      const nan = vs.some((v) => !Number.isFinite(v))
      // 平台段：只对"有变化"的通道算。中间平台（之后还会变）作为证据列出 ——
      // 它可能是"还没入场"，也可能是"这一段漏了插值"，数值本身分不出来，
      // 所以只给事实不判罪；判罪交给 audit（它看得到整帧在不在动）。
      const plateaus = []
      if (span >= 0.0005) {
        let start = -1
        for (let i = 1; i < arr.length; i++) {
          const still = Math.abs(arr[i].v - arr[i - 1].v) < 1e-3
          if (still && start === -1) start = i - 1
          if (!still && start !== -1) {
            if ((i - start) / arr.length >= 0.15) {
              plateaus.push({ from: arr[start].t, to: arr[i - 1].t, resumed: true })
            }
            start = -1
          }
        }
        if (start !== -1 && (arr.length - 1 - start) / arr.length >= 0.15) {
          plateaus.push({ from: arr[start].t, to: arr[arr.length - 1].t, resumed: false })
        }
      }
      // 单调性
      let inc = true, dec = true
      for (let i = 1; i < arr.length; i++) {
        if (arr[i].v < arr[i - 1].v - 0.002) inc = false
        if (arr[i].v > arr[i - 1].v + 0.002) dec = false
      }
      chReport[ch] = {
        first: +arr[0].v.toFixed(4), last: +arr[arr.length - 1].v.toFixed(4),
        min: +min.toFixed(4), max: +max.toFixed(4), span,
        monotonic: inc ? 'increasing' : dec ? 'decreasing' : 'non-monotonic',
        nan, plateaus: plateaus.map((p) => ({ from: +p.from.toFixed(2), to: +p.to.toFixed(2), resumed: p.resumed })),
      }
    }
    report.push({ sel: first.sel, idx: first.idx, tag: first.tag, id: first.id, cls: first.cls, channels: chReport })
  }

  const issues = []
  for (const el of report) {
    const label = `${el.sel}[${el.idx}]`
    const chans = Object.entries(el.channels)
    const active = chans.filter(([, s]) => s.span >= 0.0005)
    if (!active.length) {
      issues.push({
        level: 'info', el: label, ch: '(全部)',
        msg: '这些属性整段没有变化。两种可能：① 元素真的没动（选择器没命中 / style 没写进 DOM / 被父容器裁掉）；'
          + '② 它变的东西不在 --props 里 —— 文字数字用 text，渐变与颜色用 background，发光模糊用 filter 或 box-shadow。'
          + `当前在查：${PROPS.join(',')}`,
      })
      continue
    }
    for (const [ch, s] of chans) {
      if (s.nan) issues.push({ level: 'fail', el: label, ch, msg: '数值出现 NaN / Infinity —— 公式里有 0/0、未初始化，或字符串拼出了 "NaN"' })
      if (ch === 'opacity' && (s.min < -0.001 || s.max > 1.001)) {
        issues.push({ level: 'fail', el: label, ch, msg: `opacity 越界 [${s.min}, ${s.max}] —— 必须在 0..1，越界会被浏览器钳制造成视觉突变` })
      }
      if ((ch === 'scaleX' || ch === 'scaleY') && s.min < -0.001) {
        issues.push({ level: 'warn', el: label, ch, msg: `出现负缩放 ${s.min} —— 元素会镜像翻转，通常是缓动过冲太狠` })
      }
      for (const p of s.plateaus) {
        if (p.resumed) {
          issues.push({
            level: 'info', el: label, ch,
            msg: `${p.from}–${p.to}s 之间数值完全不变，之后又继续变化。两种解释：`
              + '① 元素这时还没入场（延迟出现），正常；② 这一段本该持续推进，但插值被拆断或漏了。'
              + '拿不准就看 audit —— 它知道整帧在不在动，能区分"整个画面都停了"和"只有它没动"',
          })
        }
      }
    }
  }
  if (idempotent.mismatches.length) {
    issues.push({
      level: 'fail', el: '(全局)', ch: '-',
      msg: `seek 不幂等：${idempotent.mismatches.length} 处同一 t 两次调用结果不同。例：${idempotent.mismatches.slice(0, 2).map((m) => `${m.sel}[${m.idx}].${m.prop} ${m.first} vs ${m.second}`).join('；')} —— seek 里改动了会累积的状态（计数器/清空的缓存/每帧重建 DOM）`,
    })
  }

  const result = {
    html: path.resolve(opt.html),
    range: [from, to], steps,
    selectors, props: PROPS,
    idempotent: opt.idempotent ? { checked: idempotent.checked, mismatches: idempotent.mismatches } : null,
    elements: report,
    issues,
  }

  if (opt.json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(`\n数值验算 ${path.basename(opt.html)}  ${from}–${to}s  ${steps} 个采样点\n`)
    const limit = opt.all ? report.length : Math.min(report.length, 8)
    for (const el of report.slice(0, limit)) {
      const chans = Object.entries(el.channels)
      const active = chans.filter(([, s]) => s.span >= 0.0005)
      const still = chans.filter(([, s]) => s.span < 0.0005)
      console.log(`  ${el.sel}[${el.idx}] <${el.tag}${el.id ? '#' + el.id : ''}${el.cls ? '.' + el.cls.split(' ')[0] : ''}>`)
      if (active.length) {
        console.log('    变化  ' + active.map(([ch, s]) =>
          `${ch} ${s.first} → ${s.last} (span ${s.span}, ${s.monotonic})`).join(' · '))
      } else {
        console.log('    变化  —（整段没有变化）')
      }
      if (still.length) console.log('    恒定  ' + still.map(([ch]) => ch).join(', '))
      const plats = active.flatMap(([ch, s]) => s.plateaus.map((p) => `${ch} ${p.from}–${p.to}s ${p.resumed ? '后继续' : '后稳定'}`))
      if (plats.length) console.log('    平台  ' + plats.join(' · '))
    }
    if (report.length > limit) console.log(`  … 还有 ${report.length - limit} 个元素未显示（--all 看全部）`)
    if (opt.idempotent) console.log(`\n  幂等性：检查 ${idempotent.checked} 个时刻，${idempotent.mismatches.length} 处不一致`)
    const tag = { fail: '✖', warn: '⚠', info: 'ℹ' }
    if (issues.length) {
      console.log('')
      for (const i of issues) console.log(`  ${tag[i.level]} ${i.el} · ${i.ch} — ${i.msg}`)
    } else {
      console.log('\n  没有发现问题。')
    }
    if (!opt.idempotent) console.log('  提示：加 --idempotent 可以验证 seek 是否幂等（这是"画面只由 t 决定"的机器证明）。\n')
    else console.log('')
  }

  process.exit(issues.some((i) => i.level === 'fail') ? 1 : 0)
} finally {
  if (cdp) cdp.close()
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    else proc.kill('SIGKILL')
  } catch {}
  await sleep(150)
  import('node:fs/promises').then((fs) => fs.rm(userDir, { recursive: true, force: true })).catch(() => {})
  if (serverInfo) serverInfo.server.close()
}
