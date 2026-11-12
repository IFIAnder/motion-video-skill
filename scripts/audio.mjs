#!/usr/bin/env node
/**
 * audio.mjs — 把一份"音频场景"算成 WAV
 *
 * 和视频那边的分工完全对称：
 *   scene.html  →  window.scene.seek(t)   →  render.mjs  →  mp4
 *   audio-scene.mjs →  export function render(s)  →  audio.mjs  →  wav
 *
 * 场景文件长这样（纯 ESM，零依赖）：
 *
 *   export const duration = 8          // 秒，通常等于片长
 *   export function render(s) {
 *     // s = { V, put, chord, mtof, ... }
 *     s.V.pad(0, 4, s.chord('F3', 'min'), 0.05, 1400)
 *     s.V.kick(2.0, 0.9)
 *     s.V.whoosh(1.6, 0.4, 400, 4000, 0.2, 0, 'swell')
 *   }
 *
 * 为什么不让模型"写个音频文件"：音频是采样级的，模型没有采样级的手感，
 * 但它很会算时间轴。所以它只负责写"什么时刻发生什么"，波形交给合成器。
 *
 *   node audio.mjs --scene audio-scene.mjs --out out/audio.wav
 *   node audio.mjs --demo --duration 8 --out out/demo.wav
 *   node audio.mjs --check
 */

import { writeFile, mkdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createSynth, CHORDS, chord, toMidi, noteToFreq, mtof } from './synth.mjs'

const argv = process.argv.slice(2)
const opt = {
  SR: 48000, seed: 1, peak: 0.89, fadeOut: 0.4, stereo: true, quiet: false,
}
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  const val = () => {
    const v = argv[++i]
    if (v === undefined) die(`${a} 缺少取值`)
    return v
  }
  switch (a) {
    case '--scene': opt.scene = val(); break
    case '--out': opt.out = val(); break
    case '--sr': opt.SR = Number(val()); break
    case '--duration': opt.duration = Number(val()); break
    case '--seed': opt.seed = Number(val()); break
    case '--peak': opt.peak = Number(val()); break
    case '--fade-out': opt.fadeOut = Number(val()); break
    case '--mono': opt.stereo = false; break
    case '--demo': opt.demo = true; break
    case '--check': opt.check = true; break
    case '--json': opt.json = val(); break
    case '--quiet': opt.quiet = true; break
    case '-h': case '--help': printHelp(); process.exit(0)
    default: die(`未知参数 ${a}（--help 查看用法）`)
  }
}

function printHelp() {
  console.log(`audio.mjs — 用代码算音频（零依赖，确定性）

  --scene <file>      音频场景 .mjs，导出 { duration, render(s) }
  --out <path>        输出 WAV，默认 out/audio.wav
  --duration <sec>    覆盖场景里的 duration
  --sr <n>            采样率，默认 48000
  --seed <n>          噪声种子，默认 1（同种子同输出，逐采样可复现）
  --peak <0-1>        归一化目标峰值，默认 0.89（约 -1 dBFS）
  --fade-out <sec>    尾部淡出，默认 0.4（必须有，否则结尾爆音）
  --mono              单声道（体积减半，手机外放没有差别）
  --demo              跑内置示例（8 秒片头级配乐），不需要场景文件
  --check             体检：Node 版本、可用的 voice 列表
  --json <path>       把统计写成 JSON
  --quiet             安静模式

场景文件里的 s 就是合成器实例，能用的 voice：

  节奏   kick sub hat clap crash tom
  旋律   blip bell pluck bass pad metal
  音效   tick click boing whoosh riser powerDown scratch sweep reverse
  组合   impact thud

  工具   chord(root, quality, octave)  mtof(midi)  noteToFreq('A4')  toMidi('A4')
         setGroup('drum'|'bass'|'music'|'fx', gain)  roomAt(t)`)
}

function die(msg) {
  console.error('✖ ' + msg)
  process.exit(1)
}
const log = (...a) => { if (!opt.quiet) console.log(...a) }

// ------------------------------------------------------------ 体检

if (opt.check) {
  const s = createSynth({ SR: opt.SR, duration: 1 })
  console.log('audio.mjs 体检')
  console.log(`  node        ${process.version}`)
  console.log(`  采样率      ${opt.SR} Hz`)
  console.log(`  默认声像    ${opt.stereo ? '立体声' : '单声道'}`)
  console.log(`  voice 数量  ${Object.keys(s.V).length}`)
  console.log(`  voice       ${Object.keys(s.V).join(' ')}`)
  console.log(`  和弦表      ${Object.keys(CHORDS).join(' ')}`)
  console.log(`  A4 = ${mtof(69)} Hz, C4 = ${noteToFreq('C4').toFixed(2)} Hz`)
  console.log('  零 npm 依赖，不需要浏览器。')
  process.exit(0)
}

// ------------------------------------------------------------ 内置示例
//
// 这段就是"片头 8 秒"该有的声音层次，可以直接当模板抄：
//   0.0  pad 起（和声垫底，几乎听不见但决定调性）
//   0.0  riser 0→1.8s（把注意力拉起来）
//   1.8  impact（画面第一击）
//   2.0  鼓组进入
//   3.6  whoosh swell 引出第二次转场
//   4.0  重击 + 和声变化
//   6.0  收尾 bell + 尾音
function demoScene(s) {
  const D = opt.duration || 8
  // 和声：Fm → Db → Ab，每 2 秒换一次
  const prog = [['F3', 'min'], ['D#3', 'maj'], ['G#2', 'maj'], ['A#2', 'maj']]
  for (let b = 0; b * 2 < D; b++) {
    const [root, q] = prog[Math.min(prog.length - 1, b)]
    s.V.pad(b * 2, Math.min(D, b * 2 + 2.2), s.chord(root, q), 0.05, 1200 + b * 200)
  }

  s.V.riser(0, 1.8, 0.14)
  s.V.impact(1.8, 1)

  // 鼓：1.8s 起，每拍一下，第 8 拍加 clap
  const beat = 0.5
  for (let t = 2.0, i = 0; t < D - 1.2; t += beat, i++) {
    s.V.kick(t, i % 4 === 0 ? 0.85 : 0.55)
    if (i % 4 === 2) s.V.clap(t, 0.28)
    s.V.hat(t + beat / 2, 0.12, 0.03, i % 2 ? 0.25 : -0.25)
    s.V.bass(t, s.toMidi('F1') + [0, 0, 8, 0][i % 4], 0.18, 0.13)
  }

  s.V.whoosh(3.4, 0.6, 500, 4000, 0.16, 0, 'swell')
  s.V.impact(4.0, 0.9)
  s.V.bell(4.02, 89, 0.9, 0.1)
  s.V.bell(4.06, 96, 0.9, 0.07, 0.35)

  // 细碎音：像 UI 元素依次落位
  for (let i = 0; i < 6; i++) {
    s.V.tick(4.4 + i * 0.08, 84 + i * 2, 0.16, (i % 2 ? 0.3 : -0.3))
    s.V.blip(4.45 + i * 0.08, s.toMidi('F5') + [0, 3, 5, 7, 10, 12][i], 0.06, 0.08, (i - 2.5) * 0.25)
  }

  s.V.whoosh(D - 2.4, 0.7, 3000, 400, 0.14)
  s.V.bell(D - 1.6, 77, 1.6, 0.08)
  s.V.kick(D - 1.6, 0.6)
  s.V.sub(D - 1.6, 29, 1.2, 0.3)
}

// ------------------------------------------------------------ 装载场景

let duration = opt.duration
let renderFn = null
let sceneName = 'demo'

if (opt.demo || !opt.scene) {
  renderFn = demoScene
  duration = duration || 8
} else {
  if (!existsSync(opt.scene)) die(`找不到场景文件 ${opt.scene}`)
  const url = pathToFileURL(path.resolve(opt.scene)).href
  let mod
  try {
    mod = await import(url)
  } catch (e) {
    die(`场景文件加载失败：${e.message}\n  场景必须是 ESM（.mjs 或 package.json 里 "type":"module"），导出 { duration, render }`)
  }
  sceneName = path.basename(opt.scene)
  if (typeof mod.render !== 'function') {
    die(`${sceneName} 没有导出 render(s)。必须 export function render(s) { ... }`)
  }
  renderFn = mod.render
  duration = opt.duration || mod.duration
  if (!duration) {
    die(`${sceneName} 没有导出 duration，也没给 --duration。音频必须有明确时长，否则无法和视频对齐`)
  }
  // 可选：场景可以声明自己对齐的视频信息，写进统计里便于核对
  opt.sceneFps = mod.fps
}

if (!(duration > 0)) die(`duration 非法：${duration}`)

// ------------------------------------------------------------ 合成

const t0 = Date.now()
const s = createSynth({ SR: opt.SR, duration, seed: opt.seed, stereo: opt.stereo })

log(`合成 ${sceneName}  ${duration}s @ ${opt.SR} Hz ${opt.stereo ? '立体声' : '单声道'}  seed=${opt.seed}`)

let renderError = null
try {
  renderFn(s)
} catch (e) {
  renderError = e
}
if (renderError) {
  die(`render(s) 抛错：${renderError.message}\n${renderError.stack.split('\n').slice(1, 4).join('\n')}`)
}

const mixed = s.master({ peak: opt.peak, fadeOut: opt.fadeOut })
const wav = s.toWav(mixed)

const outPath = path.resolve(opt.out || path.join('out', 'audio.wav'))
await mkdir(path.dirname(outPath), { recursive: true })
await writeFile(outPath, wav)

const ms = Date.now() - t0

// ------------------------------------------------------------ 统计
//
// 这几项不是装饰：它们是 audiocheck 判定的同一批数字，
// 在这里先打出来，你就不用为了看一眼峰值再跑一遍 check。

let peak = 0, sumSq = 0, clip = 0, rmsZero = 0
for (let n = 0; n < s.N; n++) {
  for (let c = 0; c < s.CH; c++) {
    const v = c === 0 ? mixed.L[n] : mixed.R[n]
    const a = Math.abs(v)
    if (a > peak) peak = a
    if (a >= 0.9999) clip++
    sumSq += v * v
  }
}
const rms = Math.sqrt(sumSq / (s.N * s.CH))

// 最长的静音段（低于 -60 dBFS 视为静音）
const qThr = 0.001
let run = 0, longestSilence = 0, silenceStart = 0, longestAt = 0
for (let n = 0; n < s.N; n++) {
  const a = Math.max(Math.abs(mixed.L[n]), s.CH === 2 ? Math.abs(mixed.R[n]) : 0)
  if (a < qThr) {
    if (run === 0) silenceStart = n / s.SR
    run++
    if (run > longestSilence * s.SR) { longestSilence = run / s.SR; longestAt = silenceStart }
  } else run = 0
}
void rmsZero

const db = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity)
const report = {
  ok: true,
  scene: sceneName,
  wav: outPath,
  duration: +duration.toFixed(4),
  sampleRate: opt.SR,
  channels: s.CH,
  frames: s.N,
  bytes: wav.length,
  ms,
  seed: opt.seed,
  peak: +peak.toFixed(4),
  peakDb: +db(peak).toFixed(2),
  rms: +rms.toFixed(4),
  rmsDb: +db(rms).toFixed(2),
  normalizeGain: +mixed.gain.toFixed(3),
  clippedSamples: clip,
  longestSilence: +longestSilence.toFixed(3),
  longestSilenceAt: +longestAt.toFixed(3),
  next: `node scripts/audiocheck.mjs --wav "${outPath}" --duration ${duration}`,
}

if (opt.json) {
  await mkdir(path.dirname(path.resolve(opt.json)), { recursive: true })
  await writeFile(path.resolve(opt.json), JSON.stringify(report, null, 2), 'utf8')
}

if (opt.quiet) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log('')
  console.log(`  写出 ${path.relative(process.cwd(), outPath)}  ${(wav.length / 1024).toFixed(0)} KB  ${ms}ms`)
  console.log(`  时长 ${duration.toFixed(2)}s  峰值 ${peak.toFixed(3)} (${db(peak).toFixed(1)} dBFS)  RMS ${db(rms).toFixed(1)} dBFS`)
  console.log(`  归一化增益 ×${mixed.gain.toFixed(2)}（归一化前峰值 ${mixed.peakBefore.toFixed(2)}）`)
  if (clip > 0) console.log(`  ⚠ 有 ${clip} 个采样贴到满刻度（会让播放器削波）`)
  if (longestSilence > 0.5) console.log(`  ⚠ 最长静音 ${longestSilence.toFixed(2)}s，从 ${longestAt.toFixed(2)}s 起`)
  console.log(`\n  下一步：node scripts/audiocheck.mjs --wav "${outPath}" --duration ${duration}`)
}
