#!/usr/bin/env node
/**
 * ease.mjs — 曲线与参数计算器（零依赖）
 *
 * 为什么需要它：模型心算 cubic-bezier 的控制点、弹簧的阻尼比、7 个元素的错开步长，
 * 错得安静又自信。这些全是确定性数学，不该由语言模型估。
 * 让它调这个脚本，把"算"这一步外包给代码，它只负责选和填。
 *
 * 子命令：
 *   cubic   <x1> <y1> <x2> <y2>        解码一条贝塞尔：采样、过冲、ASCII 曲线、JS/CSS 输出
 *   spring  <stiffness> <damping> [mass] [duration]
 *                                      真实物理弹簧：采样、过冲、稳定时间、CSS linear()、JS
 *   css-linear --preset <name>         把内置曲线转成 CSS linear(...)（现代浏览器可用）
 *   presets                            列出内置曲线及其控制点
 *   stagger <count> <total> <dur>      算错开步长，并检查是否溢出总时长
 *   contrast <bg> <fg>                 对比度 + 是否达到 WCAG AA
 *   ramp <bg> <steps>                  由底色生成可读的文字灰阶梯度（选次文字色用）
 *
 * 通用：--json 输出机器可读结果；--samples N 采样点数（默认 24）
 *
 * 例：
 *   node ease.mjs cubic 0.16 1 0.3 1
 *   node ease.mjs spring 120 14 1 1.2
 *   node ease.mjs css-linear --preset outExpo
 *   node ease.mjs stagger 7 2.4 0.5
 *   node ease.mjs contrast "#0b0e14" "#6d8bbd"
 */

const argv = process.argv.slice(2)
const cmd = argv[0]
const flags = {}
const pos = []
for (let i = 1; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--json') flags.json = true
  else if (a === '--samples') flags.samples = Number(argv[++i])
  else if (a === '--preset') flags.preset = argv[++i]
  else if (a === '--css') flags.css = true
  else if (a.startsWith('--')) { console.error(`✖ 未知选项 ${a}`); process.exit(1) }
  else pos.push(a)
}
const N = flags.samples || 24

// ---------------------------------------------------------------- 基础数学

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

/** CSS cubic-bezier(x1,y1,x2,y2)：给定时间比例 x，返回进度 y */
function cubicBezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by
  const sx = (t) => ((ax * t + bx) * t + cx) * t
  const sy = (t) => ((ay * t + by) * t + cy) * t
  const dx = (t) => (3 * ax * t + 2 * bx) * t + cx
  return (x) => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    let t = x
    for (let i = 0; i < 10; i++) {
      const e = sx(t) - x
      if (Math.abs(e) < 1e-7) break
      const d = dx(t)
      if (Math.abs(d) < 1e-7) break
      t -= e / d
    }
    // 牛顿法可能越界，退化到二分
    if (!(t >= 0 && t <= 1)) {
      let lo = 0, hi = 1
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2
        if (sx(mid) < x) lo = mid; else hi = mid
      }
      t = (lo + hi) / 2
    }
    return sy(t)
  }
}

/** 物理弹簧（单位阶跃响应），stiffness/damping/mass → 0..1 的位移 */
function springCurve(stiffness, damping, mass = 1) {
  const w0 = Math.sqrt(stiffness / mass)
  const zeta = damping / (2 * Math.sqrt(stiffness * mass))
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta)
    return (t) => {
      if (t <= 0) return 0
      const e = Math.exp(-zeta * w0 * t)
      return 1 - e * (Math.cos(wd * t) + (zeta * w0 / wd) * Math.sin(wd * t))
    }
  }
  if (Math.abs(zeta - 1) < 1e-9) {
    return (t) => (t <= 0 ? 0 : 1 - Math.exp(-w0 * t) * (1 + w0 * t))
  }
  // 过阻尼：两个不等实根，单位阶跃响应 1 + (r2·e^{r1 t} − r1·e^{r2 t})/(r1 − r2)
  const r1 = -w0 * (zeta - Math.sqrt(zeta * zeta - 1))
  const r2 = -w0 * (zeta + Math.sqrt(zeta * zeta - 1))
  return (t) => (t <= 0 ? 0 : 1 + (r2 * Math.exp(r1 * t) - r1 * Math.exp(r2 * t)) / (r1 - r2))
}

const PRESETS = {
  linear: [0, 0, 1, 1],
  ease: [0.25, 0.1, 0.25, 1],
  easeIn: [0.42, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
  easeInOut: [0.42, 0, 0.58, 1],
  inQuad: [0.11, 0, 0.5, 0], outQuad: [0.5, 1, 0.89, 1], inOutQuad: [0.45, 0, 0.55, 1],
  inCubic: [0.32, 0, 0.67, 0], outCubic: [0.33, 1, 0.68, 1], inOutCubic: [0.65, 0, 0.35, 1],
  inQuart: [0.5, 0, 0.75, 0], outQuart: [0.25, 1, 0.5, 1], inOutQuart: [0.76, 0, 0.24, 1],
  inExpo: [0.7, 0, 0.84, 0], outExpo: [0.16, 1, 0.3, 1], inOutExpo: [0.87, 0, 0.13, 1],
  inCirc: [0.55, 0, 1, 0.45], outCirc: [0, 0.55, 0.45, 1], inOutCirc: [0.85, 0, 0.15, 1],
  outBack: [0.34, 1.56, 0.64, 1], inBack: [0.36, 0, 0.66, -0.56], inOutBack: [0.68, -0.6, 0.32, 1.6],
  // 推荐的"丝滑"组合：入场轻微减速、无过冲
  silkIn: [0.22, 1, 0.36, 1],      // 很像 iOS 的进场
  silkOut: [0.4, 0, 0.2, 1],       // 利落退场
  uiEase: [0.4, 0, 0.2, 1],        // Material 3 emphasized
}

// ---------------------------------------------------------------- 分析

function analyze(fn, duration = 1, samples = N) {
  const rows = []
  let maxY = -Infinity, minY = Infinity, settle = null
  for (let i = 0; i <= samples; i++) {
    const x = i / samples
    const y = fn(x)
    rows.push({ x: +(x * duration).toFixed(4), norm: +x.toFixed(4), y: +y.toFixed(5) })
    if (y > maxY) maxY = y
    if (y < minY) minY = y
  }
  // 平台检测：连续采样之间 y 变化 < 0.002 视为视觉静止
  const plateaus = []
  let start = -1
  for (let i = 1; i < rows.length; i++) {
    const d = Math.abs(rows[i].y - rows[i - 1].y)
    if (d < 0.002 && start === -1) start = i - 1
    if (d >= 0.002 && start !== -1) {
      if ((i - start) / samples >= 0.12) plateaus.push([rows[start].x, rows[i - 1].x])
      start = -1
    }
  }
  if (start !== -1 && (rows.length - 1 - start) / samples >= 0.12) plateaus.push([rows[start].x, rows[rows.length - 1].x])
  // 稳定时间（进入 1±0.005 并保持）
  for (let i = rows.length - 1; i >= 0; i--) {
    if (Math.abs(rows[i].y - 1) > 0.005) { settle = rows[Math.min(i + 1, rows.length - 1)].x; break }
    if (i === 0) settle = 0
  }
  return { rows, maxY: +maxY.toFixed(4), minY: +minY.toFixed(4), overshoot: +(maxY - 1).toFixed(4), plateaus, settle }
}

function ascii(fn, { width = 56, height = 14, duration = 1 } = {}) {
  const grid = Array.from({ length: height }, () => Array(width).fill(' '))
  const yMin = Math.min(0, ...Array.from({ length: width }, (_, i) => fn(i / (width - 1))))
  const yMax = Math.max(1, ...Array.from({ length: width }, (_, i) => fn(i / (width - 1))))
  const toRow = (y) => Math.round((yMax - y) / (yMax - yMin) * (height - 1))
  // 1 和 0 参考线
  for (let x = 0; x < width; x++) {
    const r1 = toRow(1), r0 = toRow(0)
    if (r1 >= 0 && r1 < height) grid[r1][x] = '·'
    if (r0 >= 0 && r0 < height) grid[r0][x] = '·'
  }
  for (let x = 0; x < width; x++) {
    const y = fn(x / (width - 1))
    const r = toRow(y)
    if (r >= 0 && r < height) grid[r][x] = '█'
  }
  return grid.map((r) => '  ' + r.join('')).join('\n')
}

/** 采样点 → CSS linear() 字符串 */
function cssLinear(fn, duration, samples = N) {
  const pts = []
  for (let i = 0; i <= samples; i++) {
    const x = i / samples
    const y = fn(x)
    if (i === 0) pts.push(String(+y.toFixed(4)))
    else if (i === samples) pts.push(String(+y.toFixed(4)))
    else pts.push(`${+y.toFixed(4)} ${+(x * 100).toFixed(2)}%`)
  }
  return `linear(${pts.join(', ')})`
}

function jsFunction(name, expression) {
  return `const ${name} = (k) => ${expression};`
}

function hexToRgb(hex) {
  const h = hex.replace('#', '')
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)]
}
function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function contrastRatio(a, b) {
  const l1 = luminance(a), l2 = luminance(b)
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]
  return +((hi + 0.05) / (lo + 0.05)).toFixed(2)
}
function mix(a, b, k) {
  const A = hexToRgb(a), B = hexToRgb(b)
  const c = A.map((v, i) => Math.round(v + (B[i] - v) * k))
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('')
}

// ---------------------------------------------------------------- 子命令

function out(obj, human) {
  if (flags.json) { console.log(JSON.stringify(obj, null, 2)); return }
  if (human) console.log(human)
}

switch (cmd) {
  case 'presets': {
    const list = Object.entries(PRESETS).map(([k, v]) => ({ name: k, bezier: v, css: `cubic-bezier(${v.join(', ')})` }))
    out({ presets: list }, list.map((p) => `${p.name.padEnd(12)} cubic-bezier(${p.bezier.join(', ')})`).join('\n'))
    break
  }

  case 'cubic': {
    if (pos.length < 4) { console.error('用法: node ease.mjs cubic <x1> <y1> <x2> <y2>'); process.exit(1) }
    const [x1, y1, x2, y2] = pos.map(Number)
    if ([x1, x2].some((v) => v < 0 || v > 1)) {
      console.error('✖ x1/x2 必须在 [0,1]（CSS 规定），否则整条曲线不可用'); process.exit(1)
    }
    const fn = cubicBezier(x1, y1, x2, y2)
    const a = analyze(fn)
    const warnings = []
    if (a.overshoot > 0.15) warnings.push(`过冲 ${(a.overshoot * 100).toFixed(1)}% —— 超过 15% 容易显得廉价，除非刻意做回弹`)
    if (a.minY < -0.05) warnings.push(`负向过冲 ${(a.minY * 100).toFixed(1)}% —— 元素会先往反方向退一下，确认是想要的`)
    if (a.plateaus.length) warnings.push(`存在平台段：${a.plateaus.map(([s, e]) => `${s}–${e}`).join('、')} —— 这一段视觉上不动，audit 会报"中段静止"`)
    const human = [
      `cubic-bezier(${x1}, ${y1}, ${x2}, ${y2})`,
      ascii(fn),
      ``,
      `  采样（归一化时间 → 进度）：`,
      ...a.rows.filter((_, i) => i % Math.max(1, Math.round(a.rows.length / 9)) === 0)
        .map((r) => `    x=${r.norm.toFixed(2)}  y=${r.y.toFixed(4)}`),
      ``,
      `  峰值 ${a.maxY}   过冲 ${(a.overshoot * 100).toFixed(2)}%   平台段 ${a.plateaus.length}`,
      warnings.length ? `\n  ⚠ ${warnings.join('\n  ⚠ ')}` : '\n  ✓ 没有过冲/平台问题',
      ``,
      `  CSS:  transition-timing-function: cubic-bezier(${x1}, ${y1}, ${x2}, ${y2});`,
      `  JS（查表版，和上面的曲线逐点一致，直接粘进 seek 里）：`,
      `        const EASE = ${JSON.stringify(a.rows.map((r) => r.y))};`,
      `        const ease = (k) => {`,
      `          const n = EASE.length - 1;`,
      `          const i = Math.min(n, Math.max(0, k * n));`,
      `          const j = Math.min(n - 1, Math.floor(i));`,
      `          return EASE[j] * (1 - (i - j)) + EASE[j + 1] * (i - j);`,
      `        };`,
    ].join('\n')
    out({ bezier: [x1, y1, x2, y2], ...a, warnings }, human)
    break
  }

  case 'spring': {
    if (pos.length < 2) { console.error('用法: node ease.mjs spring <stiffness> <damping> [mass] [duration]'); process.exit(1) }
    const stiffness = Number(pos[0]), damping = Number(pos[1])
    const mass = Number(pos[2] || 1)
    const duration = Number(pos[3] || 1.2)
    const fn = springCurve(stiffness, damping, mass)
    // 采样：把 [0, duration] 映射成 0..1 的 x 传给 analyze
    const scaled = (x) => fn(x * duration)
    const a = analyze(scaled)
    const w0 = Math.sqrt(stiffness / mass)
    const zeta = damping / (2 * Math.sqrt(stiffness * mass))
    const warnings = []
    if (a.overshoot > 0.12) warnings.push(`过冲 ${(a.overshoot * 100).toFixed(1)}% —— 想克制就把 damping 提到 2*sqrt(stiffness*mass) 附近（当前 ζ=${zeta.toFixed(2)}）`)
    if (a.settle > duration * 1.02) warnings.push(`稳定时间 ${a.settle.toFixed(2)}s 超过 duration ${duration}s —— 动画会停在半路，当前进度 ${(fn(duration) * 100).toFixed(1)}%。把 duration 加到 ≥ ${a.settle.toFixed(2)}s，或降 stiffness`)
    const human = [
      `spring(stiffness=${stiffness}, damping=${damping}, mass=${mass})  duration=${duration}s`,
      `  ω₀=${w0.toFixed(2)}  ζ=${zeta.toFixed(3)}（${zeta < 1 ? '欠阻尼，会回弹' : Math.abs(zeta - 1) < 1e-6 ? '临界阻尼' : '过阻尼，不回弹但慢'}）`,
      ascii(scaled),
      ``,
      `  峰值 ${a.maxY}   过冲 ${(a.overshoot * 100).toFixed(2)}%   稳定 ${a.settle?.toFixed(2)}s   末值 ${fn(duration).toFixed(4)}`,
      warnings.length ? `\n  ⚠ ${warnings.join('\n  ⚠ ')}` : '\n  ✓ 参数合理',
      ``,
      `  CSS（现代浏览器，把整条曲线压成缓动）：`,
      `    animation-timing-function: ${cssLinear(scaled, 1, N)};`,
      ``,
      `  JS（纯函数，配合 seek 用）：`,
      `    const spring = (t) => {`,
      `      const w0 = ${w0.toFixed(6)}, zeta = ${zeta.toFixed(6)};`,
      `      if (t <= 0) return 0;`,
      `      if (zeta < 1) {`,
      `        const wd = w0 * Math.sqrt(1 - zeta * zeta);`,
      `        return 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + (zeta * w0 / wd) * Math.sin(wd * t));`,
      `      }`,
      `      return 1 - Math.exp(-w0 * t) * (1 + w0 * t);`,
      `    };`,
      `    // 用法：k = spring(${(1 / duration).toFixed(6)} * (t - START))`,
    ].join('\n')
    out({
      stiffness, damping, mass, duration, w0: +w0.toFixed(4), zeta: +zeta.toFixed(4),
      ...a, endValue: +fn(duration).toFixed(4), cssLinear: cssLinear(scaled, 1, N), warnings,
    }, human)
    break
  }

  case 'css-linear': {
    const name = flags.preset
    if (!name || !PRESETS[name]) {
      console.error(`用法: node ease.mjs css-linear --preset <${Object.keys(PRESETS).join('|')}>`)
      process.exit(1)
    }
    const [x1, y1, x2, y2] = PRESETS[name]
    const fn = cubicBezier(x1, y1, x2, y2)
    const lin = cssLinear(fn, 1, N)
    out({ preset: name, bezier: PRESETS[name], cssLinear: lin },
      `${name} = cubic-bezier(${PRESETS[name].join(', ')})\n\n  CSS:\n    animation-timing-function: ${lin};\n\n  ${N} 个采样点。linear() 支持 Chrome 113+ / Safari 17.2+ / Firefox 112+。`)
    break
  }

  case 'stagger': {
    if (pos.length < 3) { console.error('用法: node ease.mjs stagger <count> <total> <eachDuration>'); process.exit(1) }
    const count = Number(pos[0]), total = Number(pos[1]), dur = Number(pos[2])
    const step = count > 1 ? (total - dur) / (count - 1) : 0
    const last = (count - 1) * step + dur
    const warnings = []
    if (step < 0.03) warnings.push(`步长 ${step.toFixed(3)}s 过小（<30ms），视觉上会糊成一片，等于同时动`)
    if (step > 0.3) warnings.push(`步长 ${step.toFixed(3)}s 过大（>300ms），会像排队而不是一组`)
    if (last > total + 1e-6) warnings.push(`最后一段结束于 ${last.toFixed(2)}s，超出总时长 ${total}s`)
    const rows = Array.from({ length: count }, (_, i) =>
      ({ index: i, start: +(i * step).toFixed(4), end: +(i * step + dur).toFixed(4) }))
    const human = [
      `${count} 个元素，总时长 ${total}s，单个 ${dur}s`,
      `  错开步长 = (${total} - ${dur}) / (${count} - 1) = ${step.toFixed(4)}s`,
      ...rows.map((r) => `    #${r.index}  ${r.start.toFixed(3)} → ${r.end.toFixed(3)}s`),
      `  末段结束 ${last.toFixed(3)}s`,
      warnings.length ? `\n  ⚠ ${warnings.join('\n  ⚠ ')}` : '\n  ✓ 节奏合理（40–120ms 是最舒服的区间）',
      ``,
      `  JS: const START = (i) => ${step.toFixed(4)} * i;`,
    ].join('\n')
    out({ count, total, eachDuration: dur, step: +step.toFixed(4), lastEnd: +last.toFixed(4), rows, warnings }, human)
    break
  }

  case 'contrast': {
    if (pos.length < 2) { console.error('用法: node ease.mjs contrast <bgHex> <fgHex>'); process.exit(1) }
    const [bg, fg] = pos
    const ratio = contrastRatio(bg, fg)
    const verdict = ratio >= 7 ? 'AAA（正文）' : ratio >= 4.5 ? 'AA（正文）' : ratio >= 3 ? 'AA Large（仅大字号）' : '不合格'
    const warnings = []
    if (ratio < 4.5) warnings.push(`对比度 ${ratio} < 4.5，正文不合格。建议提亮前景：${mix(fg, '#ffffff', 0.25)} 或 ${mix(fg, '#ffffff', 0.4)}`)
    out({ bg, fg, ratio, verdict, warnings },
      `${bg} 上放 ${fg}  →  对比度 ${ratio}  ${verdict}\n${warnings.length ? '  ⚠ ' + warnings.join('\n  ⚠ ') : '  ✓ 达到正文标准'}`)
    break
  }

  case 'ramp': {
    if (pos.length < 1) { console.error('用法: node ease.mjs ramp <bgHex> [steps]'); process.exit(1) }
    const bg = pos[0]
    const steps = Number(pos[1] || 5)
    const rows = []
    for (let i = 1; i <= steps; i++) {
      const fg = mix(bg, '#ffffff', i / steps * 0.85)
      const r = contrastRatio(bg, fg)
      rows.push({ level: i, hex: fg, ratio: r, use: r >= 7 ? '正文/主文字' : r >= 4.5 ? '正文' : r >= 3 ? '大标题/次文字' : '装饰/禁用' })
    }
    out({ bg, ramp: rows },
      `底色 ${bg} 的文字梯度（越往下越亮）：\n` +
      rows.map((r) => `  ${r.hex}  对比度 ${String(r.ratio).padStart(5)}  ${r.use}`).join('\n'))
    break
  }

  default:
    console.error(`用法: node ease.mjs <cubic|spring|css-linear|presets|stagger|contrast|ramp> ...
  例:
    node ease.mjs cubic 0.22 1 0.36 1
    node ease.mjs spring 120 14 1 1.2
    node ease.mjs css-linear --preset silkIn
    node ease.mjs stagger 7 2.4 0.5
    node ease.mjs contrast "#0b0e14" "#6d8bbd"
    node ease.mjs ramp "#0b0e14" 5`)
    process.exit(1)
}
