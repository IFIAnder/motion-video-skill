#!/usr/bin/env node
/**
 * audit.mjs — 机器化验收动画/视频成片（零 npm 依赖，流式处理）
 *
 * 目的：把"好不好看"里能被机器判定的那部分抽出来，变成确定结论。
 * 小模型最大的短板不是想不出画面，而是不知道自己渲出来的东西是不是在动、
 * 有没有丢掉中间态、有没有闪一帧空画面、结尾有没有停在半路。
 * 这些不必靠眼睛，靠像素。有了这台机器，模型才能自己发现自己错了。
 *
 * 两个指标必须一起看，单看一个会误判：
 *   变化像素占比 changed —— 整体有多大面积在变。细元素（4px 的进度线、
 *                            一个小圆点）在缩略图上占比不到 0.1%，只看它
 *                            会把真实动效判成"没动"。
 *   局部最大灰度差 maxGray —— 有没有哪一块真的变了。压缩噪声通常 <12，
 *                            真实位移/透明度变化远高于此。靠它把
 *                            "细小但在动" 和 "真的静止" 分开。
 *
 * 判据：
 *   1. 元数据   —— 时长 / 帧率 / 分辨率 是否与声明一致
 *   2. 是否在动 —— 两项指标都接近 0 = seek 没接上，硬失败
 *   3. 静止段   —— 两项指标都低、且连续 ≥0.55s、且不在首尾 = 丢了中间态
 *   4. 跳变     —— 变化量瞬间暴涨 = 无缓动硬切 / 元素瞬移
 *   5. 平帧     —— 帧内没有亮度差异 = 纯色墙 / 黑帧 / 元素没画出来
 *   6. 闪烁     —— 动一下立刻静止，反复出现 = 帧间不一致（随机数/时钟/每帧重建 DOM）
 *   7. 节奏     —— 运动能量曲线，看动效集中释放还是匀着摊
 *   8. 循环接缝 —— --loop 时比较末帧与首帧
 *
 * 用法：
 *   node audit.mjs --video out/demo.mp4
 *   node audit.mjs --video out/demo.mp4 --fps 30 --duration 3 --width 1920 --height 1080 --loop
 *   node audit.mjs --video out/demo.mp4 --grid 480x270 --json out/audit.json
 */

import { spawn } from 'node:child_process'
import { writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const opt = { grid: '320x180', pixelThresh: 6, quiet: false }
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  const val = () => { const v = argv[++i]; if (v === undefined) fail(`参数 ${a} 缺少取值`); return v }
  switch (a) {
    case '--video': opt.video = val(); break
    case '--fps': opt.fps = Number(val()); break
    case '--duration': opt.duration = Number(val()); break
    case '--width': opt.width = Number(val()); break
    case '--height': opt.height = Number(val()); break
    case '--grid': opt.grid = val(); break
    case '--json': opt.json = val(); break
    case '--loop': opt.loop = true; break
    case '--pixel-thresh': opt.pixelThresh = Number(val()); break
    case '--quiet': opt.quiet = true; break
    case '-h': case '--help':
      console.log(`用法: node audit.mjs --video <file> [--fps N --duration S --width W --height H]
       [--grid 320x180] [--loop] [--pixel-thresh 6] [--json out.json] [--quiet]`)
      process.exit(0)
    default: fail(`未知参数 ${a}`)
  }
}
function fail(m) { console.error('✖ ' + m); process.exit(1) }
if (!opt.video) fail('缺少 --video')
if (!existsSync(opt.video)) fail(`找不到文件：${opt.video}`)

const [GW, GH] = opt.grid.split('x').map(Number)
if (!GW || !GH) fail('--grid 需要形如 320x180')
const px = GW * GH
const TH = opt.pixelThresh

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg'
const ffprobe = process.env.FFPROBE_PATH || ffmpeg.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1')

function runText(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true })
    let out = '', err = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('error', (e) => resolve({ code: -1, out, err: err + e.message }))
    p.on('close', (code) => resolve({ code, out, err }))
  })
}

// ------------------------------------------------------------ 元数据
let meta = {}
{
  const r = await runText(ffprobe, ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate,avg_frame_rate,nb_frames,duration',
    '-show_entries', 'format=duration,size', '-of', 'json', opt.video])
  if (r.code === 0) {
    try {
      const j = JSON.parse(r.out)
      const s = j.streams?.[0] || {}
      const f = j.format || {}
      meta = {
        width: s.width, height: s.height,
        nbFrames: s.nb_frames ? Number(s.nb_frames) : undefined,
        duration: Number(f.duration || s.duration || 0),
        bytes: Number(f.size || 0),
      }
      const [num, den] = String(s.avg_frame_rate || s.r_frame_rate || '0/1').split('/').map(Number)
      meta.fps = den ? num / den : num
    } catch { /* 忽略 */ }
  }
}

const fps = opt.fps || meta.fps || 30

// ------------------------------------------------------------ 流式抽帧 + 逐帧统计
const steps = []         // 相邻帧差异
const frameStats = []    // 帧内亮度分布
let firstFrame = null
let prevFrame = null
let frameIdx = 0
let errText = ''
let ffmpegCode = 0

const analyze = (f, i) => {
  let sum = 0, mn = 255, mx = 0
  for (let p = 0; p < px; p++) { const v = f[p]; sum += v; if (v < mn) mn = v; if (v > mx) mx = v }
  const mean = sum / px
  let vs = 0
  for (let p = 0; p < px; p++) { const d = f[p] - mean; vs += d * d }
  frameStats.push({ mean: +mean.toFixed(2), min: mn, max: mx, std: +Math.sqrt(vs / px).toFixed(2) })

  if (i === 0) firstFrame = Buffer.from(f)
  if (prevFrame) {
    let s = 0, mg = 0, c = 0
    for (let p = 0; p < px; p++) {
      let d = f[p] - prevFrame[p]; if (d < 0) d = -d
      s += d
      if (d > mg) mg = d
      if (d > TH) c++
    }
    steps.push({ t: +(i / fps).toFixed(3), mean: +(s / px).toFixed(3), max: mg, changed: c / px })
  }
  prevFrame = Buffer.from(f)
}

await new Promise((resolve) => {
  const p = spawn(ffmpeg, ['-v', 'error', '-i', opt.video,
    '-vf', `scale=${GW}:${GH}:flags=area,format=gray`,
    '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { windowsHide: true })
  let carry = Buffer.alloc(0)
  p.stdout.on('data', (chunk) => {
    carry = carry.length ? Buffer.concat([carry, chunk]) : chunk
    let off = 0
    while (carry.length - off >= px) {
      analyze(carry.subarray(off, off + px), frameIdx++)
      off += px
    }
    if (off > 0) carry = carry.subarray(off)
  })
  p.stderr.on('data', (d) => { errText += d })
  p.on('error', (e) => { errText += e.message; resolve() })
  p.on('close', (code) => { ffmpegCode = code; resolve() })
})

const nFrames = frameStats.length
if (ffmpegCode !== 0 || nFrames === 0) fail(`抽帧失败：${errText.split('\n').slice(-3).join(' ')}`)
if (nFrames < 2) fail('视频不足 2 帧')
const lastFrame = prevFrame

const duration = opt.duration || meta.duration || nFrames / fps
const changedSeries = steps.map((s) => s.changed)
const maxSeries = steps.map((s) => s.max)
const maxChanged = Math.max(...changedSeries)
const maxGray = Math.max(...maxSeries)
const avgChanged = changedSeries.reduce((a, b) => a + b, 0) / changedSeries.length
const sortedC = [...changedSeries].sort((a, b) => a - b)
const q = (p) => sortedC[Math.min(sortedC.length - 1, Math.floor(p * sortedC.length))]
const p50 = q(0.5), p75 = q(0.75), p95 = q(0.95)

// ------------------------------------------------------------ 结论
const findings = []
const add = (level, kind, msg, hint = '') => findings.push({ level, kind, msg, hint })
const pct = (v) => (v * 100).toFixed(2) + '%'

// 1 元数据
if (opt.width && meta.width && meta.width !== opt.width) add('fail', 'meta', `宽度 ${meta.width} ≠ 声明 ${opt.width}`, '检查 --width 是否被页面样式或 Emulation 覆盖')
if (opt.height && meta.height && meta.height !== opt.height) add('fail', 'meta', `高度 ${meta.height} ≠ 声明 ${opt.height}`, '同上')
if (opt.duration) {
  const tol = Math.max(0.1, opt.duration * 0.03)
  if (Math.abs(duration - opt.duration) > tol) {
    add('warn', 'meta', `时长 ${duration.toFixed(2)}s ≠ 声明 ${opt.duration}s（容差 ${tol.toFixed(2)}s）`,
      '总帧数应为 round(duration*fps)；注意末帧时刻是 (n-1)/fps，不是 duration')
  }
}

// 2 是否在动
if (maxChanged < 0.0003 && maxGray < 12) {
  add('fail', 'motion', `全场变化像素 ${pct(maxChanged)}、局部最大灰度差 ${maxGray}，画面没有动`,
    'scene.seek(t) 没真正改变状态：动画可能写在 requestAnimationFrame / CSS animation 里，seek 没接管；或所有元素都在 opacity:0')
} else if (maxChanged < 0.002 && maxGray < 35) {
  add('warn', 'motion', `变化很微弱（变化像素峰值 ${pct(maxChanged)}，局部灰度差 ${maxGray}）`,
    '元素太小 / 对比度太低 / 位移量太小；或只改了 opacity 的极小一段')
}

// 3 静止段（两个指标都低才算静止）
{
  const minStill = Math.max(3, Math.round(fps * 0.55))
  const isStill = (i) => steps[i].changed <= 0.0008 && steps[i].max <= 12
  const runs = []
  let start = -1
  for (let i = 0; i < steps.length; i++) {
    if (isStill(i) && start === -1) start = i
    if (!isStill(i) && start !== -1) { if (i - start >= minStill) runs.push([start + 1, i]); start = -1 }
  }
  if (start !== -1 && steps.length - start >= minStill) runs.push([start + 1, steps.length])

  const edge = Math.round(fps * 0.15)
  const mid = runs.filter(([s, e]) => s > edge && e < nFrames - edge)
  if (mid.length) {
    add('warn', 'static', `${mid.length} 段中段静止：` + mid.slice(0, 5).map(([s, e]) => `${(s / fps).toFixed(2)}–${(e / fps).toFixed(2)}s`).join('、'),
      '中间态丢了：多半只写了首末帧的公式，没有过程。看该时间窗里哪个元素本该持续变化（位移/描边/计数/进度），确认它的 t 区间覆盖到这里，且缓动末段没有提前收敛')
  } else if (runs.length) {
    add('info', 'static', `首尾静止 ${runs.map(([s, e]) => `${(s / fps).toFixed(2)}–${(e / fps).toFixed(2)}s`).join('、')}`, '入场前 / 收尾后停留，通常正常')
  }
}

// 4 跳变
{
  const base = Math.max(p75, 0.002)
  const thr = Math.max(0.05, base * 5)
  const jumps = steps.filter((s) => s.changed > thr && s.max > 45)
  if (jumps.length) {
    add('warn', 'jump', `${jumps.length} 处硬跳变（变化像素 > ${pct(thr)}）：` + jumps.slice(0, 6).map((j) => `${j.t}s ${pct(j.changed)}`).join('、'),
      '① 设计内的场景切换：在分镜表里标注后忽略；② 缺缓动：位置从 A 直接跳到 B，用 ease 插值并确认中间帧存在。也可以用 --still 单独看跳变前后两帧')
  }
}

// 5 平帧
{
  const flat = []
  frameStats.forEach((s, i) => { if (s.std < 1.0 && s.max - s.min < 5) flat.push(+(i / fps).toFixed(2)) })
  if (flat.length === nFrames) {
    add('fail', 'flat', '整片纯色：一帧有效画面都没有',
      'HTML 没画出来：选择器拼错 / 父容器高度 0 / 元素在视口外 / 全屏遮罩盖住了内容')
  } else if (flat.length) {
    add('warn', 'flat', `${flat.length}/${nFrames} 帧近乎纯色：${flat.slice(0, 6).map((t) => t + 's').join('、')}`,
      '这些时刻画面为空：元素进场太晚、提前退场、被裁掉，或该段本来就是纯色背景（设计内则忽略）')
  }
}

// 6 闪烁
{
  let flips = 0
  const at = []
  for (let i = 1; i < steps.length; i++) {
    if (steps[i - 1].max > 30 && steps[i].max <= 8) { flips++; if (at.length < 5) at.push(steps[i].t) }
  }
  if (flips >= Math.max(4, Math.round(fps * 0.12)) && maxGray > 30) {
    add('warn', 'flicker', `动了立刻又静止 ${flips} 次（${at.join('、')}s …）`,
      '帧间没有因果：检查每帧是否重建 DOM、是否读了 Math.random / Date.now / performance.now、seek 里是否改了会累积的状态（累加变量、清空的缓存）')
  }
}

// 7 节奏
const bucket = 0.25
const rhythm = []
{
  const per = Math.max(1, Math.round(fps * bucket))
  for (let i = 0; i < steps.length; i += per) {
    const slice = steps.slice(i, i + per)
    rhythm.push({
      t: +(i / fps).toFixed(2),
      changed: +(slice.reduce((a, b) => a + b.changed, 0) / slice.length * 100).toFixed(3),
      maxGray: Math.max(...slice.map((s) => s.max)),
    })
  }
}

// 8 循环接缝
if (opt.loop && firstFrame && lastFrame) {
  let s = 0, mg = 0, c = 0
  for (let i = 0; i < px; i++) {
    let d = firstFrame[i] - lastFrame[i]; if (d < 0) d = -d
    s += d; if (d > mg) mg = d; if (d > TH) c++
  }
  const seam = c / px
  if (seam > Math.max(0.01, p50 * 2) || mg > 40) {
    add('warn', 'loop', `首末帧不一致（变化像素 ${pct(seam)}，最大灰度差 ${mg}），循环处会看见跳`,
      '让 t=duration 的画面与 t=0 相同；末帧时刻是 duration - 1/fps，不是 duration')
  } else {
    add('info', 'loop', `循环接缝干净（变化像素 ${pct(seam)}）`, '')
  }
}

const fails = findings.filter((f) => f.level === 'fail')
const warns = findings.filter((f) => f.level === 'warn')
const verdict = fails.length ? 'FAIL' : warns.length ? 'WARN' : 'PASS'

const curve = (() => {
  const chars = ' .:-=+*#%@'
  const mx = Math.max(...rhythm.map((r) => r.changed), 0.0001)
  return rhythm.map((r) => chars[Math.min(9, Math.round((r.changed / mx) * 9))]).join('')
})()

const result = {
  verdict,
  file: path.resolve(opt.video),
  meta: { ...meta, declared: { fps: opt.fps, duration: opt.duration, width: opt.width, height: opt.height } },
  motion: {
    frames: nFrames, fps: +fps.toFixed(3), duration: +duration.toFixed(3), grid: `${GW}x${GH}`,
    maxChangedPct: +pct(maxChanged), avgChangedPct: +pct(avgChanged),
    p50Pct: +pct(p50), p75Pct: +pct(p75), p95Pct: +pct(p95),
    maxGray, curve, bucketSeconds: bucket,
  },
  rhythm,
  findings,
}

if (opt.json) {
  await mkdir(path.dirname(path.resolve(opt.json)), { recursive: true })
  await writeFile(path.resolve(opt.json), JSON.stringify(result, null, 2), 'utf8')
}

if (!opt.quiet) {
  const tag = { fail: '✖ FAIL', warn: '⚠ WARN', info: 'ℹ INFO' }
  console.log(`\n审计 ${path.basename(opt.video)}  →  ${verdict}\n`)
  console.log(`  帧数 ${nFrames}  帧率 ${fps.toFixed(2)}  时长 ${duration.toFixed(2)}s  ${meta.width}x${meta.height}`)
  console.log(`  变化像素  avg ${pct(avgChanged)}  p50 ${pct(p50)}  p95 ${pct(p95)}  峰值 ${pct(maxChanged)}   局部灰度差峰值 ${maxGray}`)
  console.log(`  节奏  [${curve}]   每格 ${bucket}s\n`)
  if (!findings.length) console.log('  没有发现问题。')
  for (const f of findings) {
    console.log(`  ${tag[f.level]}  [${f.kind}] ${f.msg}`)
    if (f.hint) console.log(`         → ${f.hint}`)
  }
  console.log('')
}

process.exit(fails.length ? 1 : 0)
