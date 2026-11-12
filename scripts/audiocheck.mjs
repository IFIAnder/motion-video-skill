#!/usr/bin/env node
/**
 * audiocheck.mjs — 音频验收（audit.mjs 的音频版）
 *
 * 为什么音频也需要机器验收：视频那边"看起来动了"能被像素拆穿，
 * 音频这边"听起来有声音"骗得过人，因为**你没法快速听完 60 秒**。
 * 交付前的三秒钟，这几件事只能靠机器：
 *   ① 削波 —— 峰值贴满刻度，在手机上就是破音，但耳机里只是"有点响"
 *   ② 静音段 —— 你漏算了一个时间区间，中间 0.8 秒什么都没有
 *   ③ 一个音量到底 —— 声音确实有，但从头到尾一样响，等于没有编曲
 *   ④ 首尾爆音 —— 没做淡入淡出，开头"啪"一下
 *   ⑤ 与视频等长 —— 差 0.3s 就有一截画面没声音，或声音被截断
 *
 * 判定分级和 audit.mjs 一致：FAIL 不许交付，WARN 要么改要么在交付说明里解释。
 *
 *   node audiocheck.mjs --wav out/audio.wav --duration 8
 *   node audiocheck.mjs --wav out/audio.wav --video out/v.mp4     # 顺带核对音画时长
 *   node audiocheck.mjs --wav out/audio.wav --json out/audio-audit.json
 */

import { spawn } from 'node:child_process'
import { writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { existsSync } from 'node:fs'

const argv = process.argv.slice(2)
const opt = { quiet: false, sr: 48000 }
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  const val = () => {
    const v = argv[++i]
    if (v === undefined) die(`${a} 缺少取值`)
    return v
  }
  switch (a) {
    case '--wav': opt.wav = val(); break
    case '--video': opt.video = val(); break
    case '--duration': opt.duration = Number(val()); break
    case '--peak-db': opt.peakDb = Number(val()); break
    case '--json': opt.json = val(); break
    case '--quiet': opt.quiet = true; break
    case '-h': case '--help':
      console.log(`audiocheck.mjs — 音频验收

  --wav <file>       要检查的音频（wav/mp3/m4a 都行，用 ffmpeg 解码）
  --video <file>     顺带核对音画时长是否一致
  --duration <sec>   期望时长；不给则用文件自带时长
  --json <path>      结果写 JSON
  --quiet            只输出 JSON
  --peak-db <n>      峰值下限（dBFS），默认 -6：低于它算"太小声"`)
      process.exit(0)
    default: die(`未知参数 ${a}（--help 查看用法）`)
  }
}
function die(msg) {
  console.error('✖ ' + msg)
  process.exit(1)
}

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

/** 二进制 stdout：PCM 不能按字符串收，会坏字节 */
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

if (!opt.wav) die('缺少 --wav')
if (!existsSync(opt.wav)) die(`找不到文件：${opt.wav}`)

// ------------------------------------------------------------ 元数据

let meta = {}
let metaError = ''
{
  const r = await runText(ffprobe, ['-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=sample_rate,channels,codec_name,duration',
    '-show_entries', 'format=duration,size,bit_rate', '-of', 'json', opt.wav])
  if (r.code === 0) {
    try {
      const j = JSON.parse(r.out)
      const s = j.streams?.[0] || {}
      const f = j.format || {}
      meta = {
        codec: s.codec_name,
        sr: Number(s.sample_rate) || 0,
        channels: Number(s.channels) || 0,
        duration: Number(f.duration || s.duration || 0),
        bytes: Number(f.size || 0),
        bitRate: Number(f.bit_rate || 0),
      }
    } catch (e) { metaError = `ffprobe 输出无法解析：${e.message}` }
  } else {
    metaError = (r.err || '').split('\n').map((s) => s.trim()).filter(Boolean).slice(-1)[0] || `ffprobe 退出码 ${r.code}`
  }
  if (!metaError && !meta.sr) metaError = 'ffprobe 没返回音频流（文件里可能只有视频轨）'
}

// ------------------------------------------------------------ 解码成 f32

const SR = meta.sr || opt.sr
const CH = meta.channels || 2
let pcm = null
let decodeError = metaError
if (!decodeError) {
  // 统一解成 48k 立体声 f32：后面所有计算都不用再管源格式。
  // 用 ffmpeg 解码而不是自己解 WAV，是因为交付物也可能是 m4a/mp3。
  const r = await runBin(ffmpeg, ['-y', '-v', 'error', '-i', opt.wav,
    '-f', 'f32le', '-acodec', 'pcm_f32le', '-ac', String(CH), '-ar', String(SR), '-'])
  if (r.code !== 0 || r.buf.length < 4) {
    decodeError = `解码失败：${r.err.split('\n').filter(Boolean).slice(-2).join(' ')}`
  } else {
    const n = Math.floor(r.buf.length / 4)
    pcm = new Float32Array(n)
    for (let i = 0; i < n; i++) pcm[i] = r.buf.readFloatLE(i * 4)
  }
}

if (decodeError) {
  console.error(`✖ ${decodeError}`)
  console.error(`  当前 ffmpeg = ${ffmpeg}；装 ffmpeg 或设 FFMPEG_PATH`)
  process.exit(1)
}

const nFrames = Math.floor(pcm.length / CH)
const duration = durationFromMeta()
function durationFromMeta() {
  return meta.duration || (nFrames / SR)
}
if (!(duration > 0)) die('拿不到时长：ffprobe 没给出，也解不出采样')

// ------------------------------------------------------------ 统计

const db = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity)
const findings = []
const add = (level, kind, msg, hint = '') => findings.push({ level, kind, msg, hint })

// 逐帧统计（用"帧"= 一个采样点上所有声道）
let peak = 0, sumSq = 0, clipSamples = 0
let dcSum = 0
const mono = new Float32Array(nFrames)
for (let n = 0; n < nFrames; n++) {
  let m = 0
  for (let c = 0; c < CH; c++) {
    const v = pcm[n * CH + c]
    const a = Math.abs(v)
    if (a > peak) peak = a
    if (a >= 0.9999) clipSamples++
    sumSq += v * v
    dcSum += v
    if (a > m) m = a
  }
  mono[n] = m
}
const rms = Math.sqrt(sumSq / (nFrames * CH))
const dc = dcSum / (nFrames * CH)

// 分段 RMS 曲线（每 0.25s 一格），用来画节奏条 + 判"一个音量到底"
const bucket = 0.25
const per = Math.max(1, Math.round(SR * bucket))
const segs = []
for (let s = 0; s * per < nFrames; s++) {
  const a = s * per
  const b = Math.min(nFrames, a + per)
  let ss = 0
  for (let n = a; n < b; n++) ss += mono[n] * mono[n]
  const r = Math.sqrt(ss / Math.max(1, b - a))
  segs.push({ t: +(s * bucket).toFixed(2), rms: r, db: r > 0 ? +db(r).toFixed(2) : -99 })
}

// 动态范围：取分段 RMS 的 p95 - p5
const sorted = segs.map((s) => s.rms).slice().sort((x, y) => x - y)
const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] || 0
const p05 = q(0.05), p50 = q(0.5), p95 = q(0.95)
// p05 为 0（整片有真正的静音段）时比值没有意义，标成 NaN 而不是 Infinity
const dynamicRangeDb = p05 > 0 && p95 > 0 ? db(p95) - db(p05) : NaN

// 静音段（连续低于 -60 dBFS 超过 0.3s）
const SILENCE = 0.001           // -60 dBFS
const MIN_SILENCE = 0.3
const silences = []
{
  let run = 0, start = 0
  for (let n = 0; n < nFrames; n++) {
    if (mono[n] < SILENCE) {
      if (run === 0) start = n
      run++
    } else {
      if (run / SR >= MIN_SILENCE) silences.push([start / SR, n / SR])
      run = 0
    }
  }
  if (run / SR >= MIN_SILENCE) silences.push([start / SR, nFrames / SR])
}

// 首尾爆音：开头 / 结尾 5ms 内是否直接到较高电平
const edge = Math.round(0.005 * SR)
const headMax = (() => { let m = 0; for (let n = 0; n < Math.min(edge, nFrames); n++) m = Math.max(m, mono[n]); return m })()
const tailMax = (() => { let m = 0; for (let n = Math.max(0, nFrames - edge); n < nFrames; n++) m = Math.max(m, mono[n]); return m })()

// 立体声相关性（1 = 完全一样 = 假立体声）
let stereoCorr = null
if (CH === 2) {
  let sll = 0, srr = 0, slr = 0
  for (let n = 0; n < nFrames; n++) {
    const l = pcm[n * 2], r = pcm[n * 2 + 1]
    sll += l * l; srr += r * r; slr += l * r
  }
  stereoCorr = sll > 0 && srr > 0 ? slr / Math.sqrt(sll * srr) : null
}

// ------------------------------------------------------------ 结论

const peakDb = db(peak)
const rmsDb = db(rms)

// 1 有没有声音
if (peak < 0.001) {
  add('fail', 'silent', `整段没有声音（峰值 ${peakDb.toFixed(1)} dBFS）`,
    'render(s) 里没有调用任何 V.* 方法，或全部被 groupGain 归零，或时长算成了 0')
} else if (peak < Math.pow(10, (opt.peakDb ?? -6) / 20)) {
  add('warn', 'quiet', `峰值只有 ${peakDb.toFixed(1)} dBFS，偏小`,
    `片头/音效类建议归一化到 -1 ~ -3 dBFS：audio.mjs --peak 0.89。当前是靠耳朵听不出来的那种"闷"`)
}

// 2 削波
if (clipSamples > 0) {
  const pct = (clipSamples / (nFrames * CH) * 100).toFixed(3)
  add('fail', 'clip', `${clipSamples} 个采样贴满刻度（${pct}%），播放时会破音`,
    'master 的 tanh 之后仍到 1.0：把 --peak 降到 0.85，或把某个分组 setGroup("drum", 0.8) 压下来。别指望播放器帮你限幅')
}

// 3 静音段
{
  const mid = silences.filter(([a, b]) => a > 0.15 && b < duration - 0.15)
  if (mid.length) {
    add('warn', 'silence', `${mid.length} 段中段静音：` + mid.slice(0, 5).map(([a, b]) => `${a.toFixed(2)}–${b.toFixed(2)}s`).join('、'),
      '这几段画面有声但没有声。要么给 pad 铺底，要么把音效挪进来；全片留白是设计，中间突然断掉通常是漏了')
  }
  if (silences.length && !mid.length) {
    add('info', 'silence', `首尾静音 ${silences.map(([a, b]) => `${a.toFixed(2)}–${b.toFixed(2)}s`).join('、')}`,
      '开头前 / 收尾后留白，通常正常')
  }
}

// 4 动态范围（有没有"编曲"）
if (segs.length >= 4 && Number.isFinite(dynamicRangeDb) && peak > 0.01) {
  if (dynamicRangeDb < 3) {
    add('warn', 'flat', `动态范围只有 ${dynamicRangeDb.toFixed(1)} dB（p95−p5），从头到尾一个响度`,
      '这通常是"铺了一层持续的 pad 或者一直在响的音效"，但没有任何起伏。加节拍、加留白、在关键点补 impact，让 RMS 曲线有形状')
  } else if (dynamicRangeDb > 40) {
    add('info', 'flat', `动态范围 ${dynamicRangeDb.toFixed(1)} dB，起伏很大`,
      '有很安静的段落和很响的落点。如果不是刻意设计，检查是否有突兀的重击')
  }
}

// 5 首尾爆音
{
  if (headMax > 0.15) {
    add('warn', 'edge', `开头 5ms 就跳到 ${db(headMax).toFixed(1)} dBFS，会有"啪"的一声`,
      'audio.mjs 默认有 5ms 淡入；如果自己改了 fadeIn=0，改回去。或者在第一个音之前留 10–20ms 空')
  }
  if (tailMax > 0.05) {
    add('warn', 'edge', `结尾 5ms 还有 ${db(tailMax).toFixed(1)} dBFS，截断会有爆音`,
      '给 --fade-out（默认 0.4s）。收尾的 bell 尾音被截断时最容易出现')
  }
}

// 6 直流偏移
if (Math.abs(dc) > 0.01) {
  add('warn', 'dc', `直流偏移 ${dc.toFixed(4)}（|DC| > 0.01）`,
    '某个 voice 的长音没有回到 0，或者低频 sub 太长被截断。会让整体音量感知变小、并浪费动态余量')
}

// 7 假立体声
if (stereoCorr !== null && stereoCorr > 0.999) {
  add('info', 'stereo', `左右声道相关性 ${stereoCorr.toFixed(4)}，实际是单声道`,
    '所有 voice 的 pan 都是 0 时就会这样。想让声场宽一点：给 hat/tick 交替 pan ±0.25，pad 的失谐层已经自带 pan')
}

// 8 与视频对齐
if (opt.video) {
  if (!existsSync(opt.video)) {
    add('warn', 'sync', `找不到视频 ${opt.video}，跳过时长核对`, '')
  } else {
    const r = await runText(ffprobe, ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=duration', '-show_entries', 'format=duration', '-of', 'json', opt.video])
    let vDur = 0
    if (r.code === 0) {
      try {
        const j = JSON.parse(r.out)
        vDur = Number(j.format?.duration || j.streams?.[0]?.duration || 0)
      } catch { /* 忽略 */ }
    }
    if (vDur > 0) {
      const diff = Math.abs(duration - vDur)
      const tol = 1 / 30   // 一帧
      if (diff > Math.max(tol, 0.05)) {
        add('fail', 'sync', `音频 ${duration.toFixed(3)}s ≠ 视频 ${vDur.toFixed(3)}s（差 ${(diff * 1000).toFixed(0)}ms）`,
          '合流时短的一边会被 ffmpeg 补齐或截断：画面最后没有声音，或最后一句音效被切掉。把 duration 对齐到视频时长')
      } else {
        add('info', 'sync', `音画等长（差 ${(diff * 1000).toFixed(1)}ms）`, '')
      }
    }
  }
}

// 9 期望时长
if (opt.duration && Math.abs(duration - opt.duration) > Math.max(0.05, 1 / 30)) {
  add('warn', 'duration', `时长 ${duration.toFixed(3)}s ≠ 声明 ${opt.duration}s（差 ${((duration - opt.duration) * 1000).toFixed(0)}ms）`,
    '--duration 应该和画面时长一致。差太多说明场景里的 duration 写错了')
}

const fails = findings.filter((f) => f.level === 'fail')
const warns = findings.filter((f) => f.level === 'warn')
const verdict = fails.length ? 'FAIL' : warns.length ? 'WARN' : 'PASS'

// ------------------------------------------------------------ 输出

const curve = (() => {
  const chars = ' .:-=+*#%@'
  const mx = Math.max(...segs.map((s) => s.rms), 1e-9)
  return segs.map((s) => chars[Math.min(9, Math.round((s.rms / mx) * 9))]).join('')
})()

const result = {
  verdict,
  file: path.resolve(opt.wav),
  video: opt.video ? path.resolve(opt.video) : null,
  format: meta,
  analysis: {
    frames: nFrames,
    sampleRate: SR,
    channels: CH,
    duration: +duration.toFixed(4),
    peak: +peak.toFixed(4),
    peakDb: +peakDb.toFixed(2),
    rms: +rms.toFixed(4),
    rmsDb: +rmsDb.toFixed(2),
    dynamicRangeDb: Number.isFinite(dynamicRangeDb) ? +dynamicRangeDb.toFixed(2) : null,
    p05Db: p05 > 0 ? +db(p05).toFixed(2) : null,
    p50Db: p50 > 0 ? +db(p50).toFixed(2) : null,
    p95Db: p95 > 0 ? +db(p95).toFixed(2) : null,
    clippedSamples: clipSamples,
    dcOffset: +dc.toFixed(5),
    stereoCorrelation: stereoCorr === null ? null : +stereoCorr.toFixed(4),
    headMaxDb: +db(headMax).toFixed(2),
    tailMaxDb: +db(tailMax).toFixed(2),
    silences: silences.map(([a, b]) => [+a.toFixed(3), +b.toFixed(3)]),
    curve,
    bucketSeconds: bucket,
  },
  findings,
}

if (opt.json) {
  await mkdir(path.dirname(path.resolve(opt.json)), { recursive: true })
  await writeFile(path.resolve(opt.json), JSON.stringify(result, null, 2), 'utf8')
}

if (opt.quiet) {
  console.log(JSON.stringify(result, null, 2))
} else {
  const tag = { fail: '✖ FAIL', warn: '⚠ WARN', info: 'ℹ INFO' }
  console.log(`\n音频审计 ${path.basename(opt.wav)}  →  ${verdict}\n`)
  console.log(`  时长 ${duration.toFixed(2)}s  ${meta.codec || '?'} ${SR}Hz ${CH}ch  ${(meta.bytes / 1024).toFixed(0)} KB`)
  console.log(`  峰值 ${peakDb.toFixed(1)} dBFS   RMS ${rmsDb.toFixed(1)} dBFS   动态范围 ${Number.isFinite(dynamicRangeDb) ? dynamicRangeDb.toFixed(1) + ' dB' : '—'}`)
  console.log(`  节奏  [${curve}]   每格 ${bucket}s\n`)
  if (!findings.length) console.log('  没有发现问题。')
  for (const f of findings) {
    console.log(`  ${tag[f.level]}  [${f.kind}] ${f.msg}`)
    if (f.hint) console.log(`         → ${f.hint}`)
  }
  console.log('')
}

process.exit(fails.length ? 1 : 0)
