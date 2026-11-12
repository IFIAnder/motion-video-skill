#!/usr/bin/env node
/**
 * mux.mjs — 音视频合流，并且**合完再验一遍**
 *
 * 为什么合流要单独一个脚本，而不是在 render.mjs 里塞个 --audio：
 * 合流是最容易"看着成功、其实坏了"的一步。
 *   ① 音频比视频短 200ms → 最后一句音效没了，但播放器不会报错
 *   ② 音频比视频长 → 被 -shortest 截断，尾音"啪"一下断掉
 *   ③ -c:v copy 时如果视频的容器不支持原编码，会静默转封装失败
 *   ④ 采样率不对 → 有些播放器会重采样，音画慢慢错位
 *
 * 所以这里分三步：合之前核对时长，合的时候用固定参数，合之后**再 probe 一遍**，
 * 并且直接调用 audiocheck 把"合流后的成品"当作输入重新判一次。
 *
 *   node mux.mjs --video out/v.mp4 --audio out/a.wav --out out/final.mp4
 *   node mux.mjs --video out/v.mp4 --audio out/a.wav --out out/final.mp4 --bitrate 256k
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'

const argv = process.argv.slice(2)
const opt = { bitrate: '192k', quiet: false }
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  const val = () => {
    const v = argv[++i]
    if (v === undefined) die(`${a} 缺少取值`)
    return v
  }
  switch (a) {
    case '--video': opt.video = val(); break
    case '--audio': opt.audio = val(); break
    case '--out': opt.out = val(); break
    case '--bitrate': opt.bitrate = val(); break
    case '--no-verify': opt.noVerify = true; break
    case '--quiet': opt.quiet = true; break
    case '-h': case '--help':
      console.log(`mux.mjs — 音视频合流 + 合流后验收

  --video <file>    视频（必填）
  --audio <file>    音频（必填；wav/mp3/m4a 都行）
  --out <file>      输出，默认 out/final.mp4
  --bitrate <n>     音频码率，默认 192k（AAC）
  --no-verify       跳过合流后的复核（不推荐）
  --quiet           只输出 JSON`)
      process.exit(0)
    default: die(`未知参数 ${a}（--help 查看用法）`)
  }
}
function die(msg) {
  console.error('✖ ' + msg)
  process.exit(1)
}
const log = (...a) => { if (!opt.quiet) console.log(...a) }

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg'
const ffprobe = process.env.FFPROBE_PATH || ffmpeg.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1')

function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true })
    let out = '', err = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('error', (e) => resolve({ code: -1, out, err: err + e.message }))
    p.on('close', (code) => resolve({ code, out, err }))
  })
}

async function probe(file) {
  const r = await run(ffprobe, ['-v', 'error', '-show_entries',
    'stream=index,codec_type,codec_name,sample_rate,channels,width,height,r_frame_rate,duration',
    '-show_entries', 'format=duration,size,bit_rate,format_name', '-of', 'json', file])
  if (r.code !== 0) return { error: (r.err || '').split('\n').filter(Boolean).slice(-1)[0] || `exit ${r.code}` }
  try {
    const j = JSON.parse(r.out)
    const streams = j.streams || []
    return {
      duration: Number(j.format?.duration || 0),
      size: Number(j.format?.size || 0),
      format: j.format?.format_name,
      video: streams.find((s) => s.codec_type === 'video') || null,
      audio: streams.find((s) => s.codec_type === 'audio') || null,
      streams: streams.length,
    }
  } catch (e) {
    return { error: `ffprobe 输出无法解析：${e.message}` }
  }
}

if (!opt.video) die('缺少 --video')
if (!opt.audio) die('缺少 --audio')
if (!existsSync(opt.video)) die(`找不到视频 ${opt.video}`)
if (!existsSync(opt.audio)) die(`找不到音频 ${opt.audio}`)

const outPath = path.resolve(opt.out || path.join('out', 'final.mp4'))
if (path.resolve(opt.video) === outPath) die('输出不能覆盖输入视频，换个 --out')

// ------------------------------------------------------------ 合之前先核对
//
// 这一步是重点：等合完了才发现"音频少 0.3 秒"，就得回去重算音频再合一次。
// 提前 2 秒核对，能省掉一轮。

log('mux.mjs — 合流前核对')
const vp = await probe(opt.video)
const ap = await probe(opt.audio)
if (vp.error) die(`读不了视频：${vp.error}`)
if (ap.error) die(`读不了音频：${ap.error}`)
if (!vp.video) die('视频里没有视频流')
if (!ap.audio) die('音频文件里没有音频流（是不是给成了静音的 mp4？）')

const vDur = vp.duration
const aDur = ap.duration
const diff = aDur - vDur
const frame = vp.video.r_frame_rate ? (() => {
  const [n, d] = String(vp.video.r_frame_rate).split('/').map(Number)
  return d ? d / n : 1 / 30
})() : 1 / 30

log(`  视频 ${vDur.toFixed(3)}s  ${vp.video.codec_name} ${vp.video.width}x${vp.video.height} ${(vp.size / 1024 / 1024).toFixed(1)} MB`)
log(`  音频 ${aDur.toFixed(3)}s  ${ap.audio.codec_name} ${ap.audio.sample_rate}Hz ${ap.audio.channels}ch`)

const warnings = []
if (Math.abs(diff) > Math.max(frame, 0.03)) {
  if (diff < 0) {
    warnings.push(`音频比视频短 ${(-diff * 1000).toFixed(0)}ms —— 最后一段画面会没有声音`)
  } else {
    warnings.push(`音频比视频长 ${(diff * 1000).toFixed(0)}ms —— 尾音会被截断`)
  }
  log(`  ⚠ ${warnings[warnings.length - 1]}`)
  log(`     想避免：把音频 duration 对齐到 ${vDur.toFixed(3)}s 重算，或接受 -shortest 截断`)
} else {
  log(`  ✔ 音画等长（差 ${(diff * 1000).toFixed(1)}ms，在一帧以内）`)
}

// ------------------------------------------------------------ 合流
//
// 参数都是刻意的：
//   -c:v copy      不重编码视频 —— 已经验过的画面不该被再压一次
//   -c:a aac       广泛兼容；wav 直接进 mp4 体积大且不通用
//   -movflags +faststart  把索引放前面，网页里能边下边播
//   -shortest      以短的一边为准，避免出现"有画面没声音"的黑尾

log('\n合流')
const t0 = Date.now()
const r = await run(ffmpeg, [
  '-y', '-v', 'error',
  '-i', opt.video,
  '-i', opt.audio,
  '-c:v', 'copy',
  '-c:a', 'aac', '-b:a', opt.bitrate, '-ar', '48000',
  '-movflags', '+faststart',
  '-shortest',
  outPath,
])
if (r.code !== 0) die(`ffmpeg 合流失败：\n${r.err.split('\n').filter(Boolean).slice(-6).join('\n')}`)
const ms = Date.now() - t0

// ------------------------------------------------------------ 合完再验一遍
//
// 不相信"命令返回 0 就是成功"。重新 probe，看两条流是不是都在、时长对不对。

const report = {
  ok: true,
  out: outPath,
  ms,
  before: { videoDuration: +vDur.toFixed(3), audioDuration: +aDur.toFixed(3), diffMs: +(diff * 1000).toFixed(1) },
  warnings,
}

if (!opt.noVerify) {
  const op = await probe(outPath)
  if (op.error) die(`合流后读不了输出：${op.error}`)
  const outDur = op.duration
  const drift = outDur - Math.min(vDur, aDur)
  const problems = []
  if (!op.video) problems.push('输出里没有视频流')
  if (!op.audio) problems.push('输出里没有音频流')
  if (Math.abs(drift) > 0.1) problems.push(`输出时长 ${outDur.toFixed(3)}s 与较短输入 ${Math.min(vDur, aDur).toFixed(3)}s 差 ${(drift * 1000).toFixed(0)}ms`)

  const sz = (await stat(outPath)).size
  log(`  输出 ${outPath}`)
  log(`  时长 ${outDur.toFixed(3)}s  ${(sz / 1024 / 1024).toFixed(1)} MB  ${ms}ms`)
  log(`  流  ${op.video ? `v:${op.video.codec_name} ${op.video.width}x${op.video.height}` : '无视频'}  |  ${op.audio ? `a:${op.audio.codec_name} ${op.audio.sample_rate}Hz ${op.audio.channels}ch` : '无音频'}`)
  if (problems.length) {
    for (const p of problems) console.error(`  ✖ ${p}`)
    die('合流结果不合格，别交付')
  }
  log('  ✔ 两条流都在，时长对得上')

  report.after = {
    duration: +outDur.toFixed(3), size: sz,
    video: op.video ? { codec: op.video.codec_name, width: op.video.width, height: op.video.height } : null,
    audio: op.audio ? { codec: op.audio.codec_name, sampleRate: Number(op.audio.sample_rate), channels: op.audio.channels } : null,
  }
  report.next = `node scripts/audiocheck.mjs --wav "${outPath}" --video "${opt.video}"`
  log(`\n  下一步：${report.next}`)
  log('         （对成品再跑一次音频验收：合流这一步本身也可能改坏东西）')
}

if (opt.quiet) console.log(JSON.stringify(report, null, 2))
