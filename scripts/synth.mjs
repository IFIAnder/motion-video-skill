#!/usr/bin/env node
/**
 * synth.mjs — 离线确定性合成器（零依赖）
 *
 * 为什么音频要"用代码算"而不是找素材：
 *   视频那边我们靠 seek(t) 把动画变成纯函数，所以能逐帧重现、能被 audit 判定。
 *   音频如果去下载素材，就立刻失去这三样东西：可重现、可对拍、可微调。
 *   一段 4.2s 时落下的"叮"，如果它是算出来的，你就能把它挪到 4.35s 再算一遍；
 *   如果它是 mp3，你只能导进编辑器手动对齐。
 *
 * 事实：几乎所有"有质感"的 UI/片头音效都是十几行数学 ——
 *   底鼓是 48→178 Hz 的快速扫频加指数衰减；踩镲是白噪声过高通再快衰减；
 *   拨弦是 Karplus-Strong（一段噪声环 + 平均滤波）；混响是 Freeverb（梳状 + 全通）。
 *   这些都能在几十个采样内写完，而且算出来的比素材库更贴合画面。
 *
 * 确定性：所有噪声来自固定种子的 LCG。同样的场景文件、同样的参数，
 * 算出来的 WAV 逐采样一致（可哈希、可回归）。
 *
 * 采样精确：每个 voice 从 t0 起按 1/SR 步进写入总线，不经过任何重采样或量化，
 * 因此"第 4.200 秒的那一帧画面"与"第 4.200 秒的那个音头"是同一个时间轴。
 */

const A4 = 440
export const mtof = (m) => A4 * Math.pow(2, (m - 69) / 12)

/** 半音 → 频率，接受小数（微分音、失谐） */
export const noteToFreq = (name) => {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(name)
  if (!m) return NaN
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1]]
  const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0
  return mtof((Number(m[3]) + 1) * 12 + base + acc)
}

/** 音名数组 → MIDI 数组，方便写和弦 */
export const toMidi = (name) => {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(name)
  if (!m) return NaN
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1]]
  const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0
  return (Number(m[3]) + 1) * 12 + base + acc
}

/** 常见和弦，返回 MIDI 音高数组。写配乐时不用手算音程。 */
export const CHORDS = {
  maj: [0, 4, 7], min: [0, 3, 7], dim: [0, 3, 6], aug: [0, 4, 8],
  sus2: [0, 2, 7], sus4: [0, 5, 7],
  maj7: [0, 4, 7, 11], min7: [0, 3, 7, 10], dom7: [0, 4, 7, 10],
  maj9: [0, 4, 7, 11, 14], min9: [0, 3, 7, 10, 14], add9: [0, 4, 7, 14],
  min6: [0, 3, 7, 9],
}
export const chord = (rootName, quality = 'min', octave = 0) =>
  CHORDS[quality].map((iv) => toMidi(rootName) + iv + octave * 12)

/**
 * @param {object} o
 * @param {number} o.SR        采样率，默认 48000（影片标准）
 * @param {number} o.duration  时长（秒）
 * @param {number} o.seed      噪声种子；改它 = 换一版"随机"纹理，但每次跑仍可复现
 * @param {boolean} o.stereo   是否立体声，默认 true
 */
export function createSynth({ SR = 48000, duration, seed = 1, stereo = true } = {}) {
  if (!duration || duration <= 0) throw new Error('createSynth 需要 duration（秒）')

  const N = Math.ceil(duration * SR)
  const CH = stereo ? 2 : 1

  // 四条分组总线：鼓 / 低音 / 旋律 / 音效。
  // 分开的理由是配器时你会想"整体把鼓压 3 dB"，而不用去改二十处 voice 调用。
  // 缓冲区按 N*CH 交错存放：长度写成 N 的话，右声道写入会越界被静默丢弃，
  // 读回来是 undefined，一路乘出 NaN —— 这个坑踩过一次，别再踩。
  const GROUPS = ['drum', 'bass', 'music', 'fx']
  const dry = {}, send = {}
  for (const g of GROUPS) {
    dry[g] = new Float32Array(N * CH)
    send[g] = new Float32Array(N * CH)
  }
  const masterL = new Float32Array(N)
  const masterR = new Float32Array(N)
  const groupGain = { drum: 1, bass: 1, music: 1, fx: 1 }

  let seedState = seed >>> 0
  const rnd = () => {
    seedState = (seedState * 1664525 + 1013904223) >>> 0
    return (seedState / 4294967296) * 2 - 1
  }
  const noise = () => rnd()

  /** 指数衰减包络：attack 内线性爬升，之后指数落。tt 是从音头起的秒数。 */
  const env = (tt, a = 0.002, d = 0.2) =>
    tt < a ? tt / a : Math.exp(-(tt - a) / d)

  /**
   * 写入一段波形。
   * gen(tt) 必须是纯函数（只看 tt，不看全局状态），否则重现性就没了；
   * 需要相位累积的 voice 自己闭包一个 ph，那是"从 t0 开始的积分"，仍然确定。
   */
  function put(t0, dur, gen, { g = 1, pan = 0, rev = 0.15, group = 'fx' } = {}) {
    const s0 = Math.round(t0 * SR)
    const n = Math.round(dur * SR)
    // 等功率声像：硬左 = cos(0)=1/sin(0)=0，硬右反之，中间各 0.707
    const pl = Math.cos((pan + 1) * Math.PI / 4)
    const pr = Math.sin((pan + 1) * Math.PI / 4)
    const buf = dry[group] || dry.fx
    const snd = send[group] || send.fx
    for (let i = 0; i < n; i++) {
      const k = s0 + i
      if (k < 0) continue
      if (k >= N) break
      const v = gen(i / SR) * g
      if (CH === 2) {
        buf[k * 2] += v * pl
        buf[k * 2 + 1] += v * pr
        snd[k * 2] += v * pl * rev
        snd[k * 2 + 1] += v * pr * rev
      } else {
        buf[k] += v
        snd[k] += v * rev
      }
    }
  }

  /**
   * Chamberlin 状态变量滤波器。SVF 的好处是同一个实例能连续输出
   * 低通 / 带通 / 高通，而且 cutoff 可以逐采样改 —— whoosh 就靠这个扫。
   * 注意：它在极限频率会不稳定，所以 clamp 到 SR/6。
   */
  const svf = (fc, Q = 1, mode = 'band') => {
    let low = 0, band = 0
    return (x, f2) => {
      const f = 2 * Math.sin(Math.PI * Math.min(f2 || fc, SR / 6) / SR)
      low += f * band
      const high = x - low - band / Q
      band += f * high
      return mode === 'band' ? band : mode === 'low' ? low : high
    }
  }

  // ============================================================ voices
  // 每个 voice 的签名都刻意写成 (t, ...参数)，第一个参数永远是落点时刻，
  // 这样配器时整份谱子读起来就是"什么时间发生什么"。

  const V = {
    /** 底鼓：48→178 Hz 扫频 + 指数衰减 + 4ms 噪声击槌。0.5s 内结束。 */
    kick(t, g = 1, { tune = 1, decay = 0.16, group = 'drum' } = {}) {
      let ph = 0
      put(t, 0.5, (tt) => {
        ph += 2 * Math.PI * (48 + 130 * Math.exp(-tt * 30)) * tune / SR
        return Math.sin(ph) * env(tt, 0.002, decay) + (tt < 0.004 ? noise() * 0.5 : 0)
      }, { g: 0.9 * g, rev: 0.03, group })
    },

    /** 超低音：给 impact 垫底，让"砸下来"有胸腔感。29 = F1 附近。 */
    sub(t, m = 29, dur = 1.2, g = 0.5) {
      let ph = 0
      const f = mtof(m)
      put(t, dur, (tt) => {
        ph += 2 * Math.PI * f * (1 + 0.6 * Math.exp(-tt * 10)) / SR
        return Math.sin(ph) * env(tt, 0.005, dur / 3)
      }, { g, rev: 0, group: 'bass' })
    },

    /** 踩镲：白噪声过"高通"（原噪声减一阶低通）+ 极短衰减。 */
    hat(t, g = 0.16, d = 0.03, pan = 0) {
      let lp = 0
      put(t, d * 6, (tt) => {
        const x = noise()
        lp += 0.6 * (x - lp)
        return (x - lp) * env(tt, 0.0005, d)
      }, { g, pan, rev: 0.05, group: 'drum' })
    },

    /** 拍手：三次 11ms 间隔的短爆发 + 一段尾巴，模拟多人拍手的微小错开。 */
    clap(t, g = 0.4) {
      const bp = svf(1500, 1.2)
      put(t, 0.4, (tt) => {
        const e = [0, 0.011, 0.022].reduce((a, o) => a + (tt >= o ? Math.exp(-(tt - o) / 0.006) : 0), 0) * 0.6
          + (tt > 0.022 ? Math.exp(-(tt - 0.022) / 0.09) : 0)
        return bp(noise()) * e * 2
      }, { g, rev: 0.3, group: 'drum' })
    },

    /** 吊镲：噪声过带通 + 长衰减。收尾那一下用它，比"铛"更不抢戏。 */
    crash(t, g = 0.2, d = 0.7) {
      let lp = 0
      put(t, d * 4, (tt) => {
        const x = noise()
        lp += 0.35 * (x - lp)
        return (x - lp) * env(tt, 0.001, d)
      }, { g, rev: 0.4, group: 'drum' })
    },

    /** 通鼓：1.2 倍频程下扫，比底鼓长、比 sub 短。做"节奏上行"最省事。 */
    tom(t, m, g = 0.4) {
      let ph = 0
      const f = mtof(m)
      put(t, 0.4, (tt) => {
        ph += 2 * Math.PI * f * (1 + 1.2 * Math.exp(-tt * 25)) / SR
        return Math.sin(ph) * env(tt, 0.001, 0.09)
      }, { g, rev: 0.12, group: 'drum' })
    },

    /** 咔哒：带音高的极短正弦 + 2ms 噪声。文字逐字出现、网格逐格落位用它。 */
    tick(t, m = 84, g = 0.3, pan = 0) {
      const f = mtof(m)
      put(t, 0.08, (tt) =>
        Math.sin(2 * Math.PI * f * tt) * Math.exp(-tt / 0.012)
        + noise() * Math.exp(-tt / 0.002) * 0.3,
        { g, pan, rev: 0.12, group: 'fx' })
    },

    /** 纯噪声点击：只过 5 kHz 高通。最轻的 UI 反馈，密集使用也不糊。 */
    click(t, g = 0.1, pan = 0) {
      const hp = svf(5000, 0.8, 'high')
      put(t, 0.03, (tt) => hp(noise()) * Math.exp(-tt / 0.004), { g, pan, rev: 0.05, group: 'fx' })
    },

    /** blip：正弦 + 三角波混合，短促有"电子感"。做琶音和提示音。 */
    blip(t, m, d = 0.1, g = 0.2, pan = 0, rev = 0.25) {
      let ph = 0
      const f = mtof(m)
      put(t, d * 5, (tt) => {
        ph += f / SR
        const tri = 1 - 4 * Math.abs((ph % 1) - 0.5)
        return (0.7 * Math.sin(2 * Math.PI * ph) + 0.3 * tri) * env(tt, 0.002, d)
      }, { g, pan, rev, group: 'music' })
    },

    /** 钟：FM 合成，调制指数随时间衰减 —— 这就是"金属余韵"的来源。 */
    bell(t, m, d = 1.0, g = 0.15, pan = 0) {
      const f = mtof(m)
      put(t, d * 4, (tt) => {
        const I = 2.2 * Math.exp(-tt * 4)
        return Math.sin(2 * Math.PI * f * tt + I * Math.sin(2 * Math.PI * f * 3.5 * tt)) * env(tt, 0.002, d)
      }, { g, pan, rev: 0.45, group: 'music' })
    },

    /** 弹簧音：音高加一个 14 Hz 的指数衰减摆动。卡通感、弹跳落点。 */
    boing(t, m, g = 0.25) {
      let ph = 0
      const f = mtof(m)
      put(t, 0.5, (tt) => {
        ph += 2 * Math.PI * f * (1 + 0.5 * Math.exp(-tt * 12) * Math.sin(2 * Math.PI * 14 * tt)) / SR
        return Math.sin(ph) * env(tt, 0.002, 0.12)
      }, { g, rev: 0.2, group: 'fx' })
    },

    /** Karplus-Strong 拨弦：一段噪声当延迟线，每圈做 0.5/0.5 平均 + 反馈衰减。 */
    pluck(t, m, g = 0.15, pan = 0, fb = 0.996) {
      const p = Math.max(2, Math.round(SR / mtof(m)))
      const b = new Float32Array(p).map(() => noise())
      let i = 0
      put(t, 0.9, () => {
        const a = b[i], c = b[(i + 1) % p]
        b[i] = (a + c) * 0.5 * fb
        i = (i + 1) % p
        return a
      }, { g, pan, rev: 0.3, group: 'music' })
    },

    /** 贝斯：锯齿波过随时间闭合的低通（200→1800 Hz 一起一落）。 */
    bass(t, m, d = 0.2, g = 0.18) {
      const f = mtof(m)
      let ph = 0, lp = 0
      put(t, d + 0.05, (tt) => {
        ph = (ph + f / SR) % 1
        const fc = 200 + 1600 * Math.exp(-tt * 18)
        lp += (1 - Math.exp(-2 * Math.PI * fc / SR)) * ((2 * ph - 1) - lp)
        const tail = tt < d ? 1 : Math.max(0, 1 - (tt - d) / 0.05)
        return (lp + 0.6 * Math.sin(2 * Math.PI * ph)) * env(tt, 0.003, d * 0.6) * tail
      }, { g, rev: 0.02, group: 'bass' })
    },

    /**
     * pad：三个失谐锯齿（-8c / 0 / +9c）+ 低通。
     * 失谐是为了"宽"—— 三个完全同频的振荡器叠起来只有音量变大，不会变宽。
     */
    pad(t0, t1, notes, g = 0.05, cutoff = 1400) {
      for (const m of notes) {
        for (const det of [-0.08, 0, 0.09]) {
          const f = mtof(m + det)
          const a = 1 - Math.exp(-2 * Math.PI * cutoff / SR)
          const dur = t1 - t0 + 0.5
          let ph = Math.abs(rnd()), lp = 0
          put(t0, dur, (tt) => {
            ph = (ph + f / SR) % 1
            lp += a * ((2 * ph - 1) - lp)
            return lp * Math.min(1, tt / 0.2) * Math.min(1, Math.max(0, (dur - tt) / 0.5))
          }, { g, pan: det * 6, rev: 0.4, group: 'music' })
        }
      }
    },

    /**
     * whoosh：噪声过带通，中心频率在 f0→f1 之间扫。
     * shape='bell' 中间最响（经过）；'swell' 末端最响（引出下一击）。
     */
    whoosh(t, dur, f0, f1, g = 0.25, pan = 0, shape = 'bell') {
      const bp = svf(f0, 2.5)
      put(t, dur, (tt) => {
        const u = tt / dur
        const e = shape === 'swell'
          ? Math.pow(u, 2.2) * (u < 0.97 ? 1 : (1 - u) / 0.03)
          : Math.pow(Math.sin(Math.PI * u), 2)
        return bp(noise(), f0 * Math.pow(f1 / f0, u)) * e * 2
      }, { g, pan, rev: 0.3, group: 'fx' })
    },

    /** 上升音：噪声带上扫 + 一条正弦爬音。转场前 1–2 秒用它把注意力拉起来。 */
    riser(t0, t1, g = 0.16) {
      const bp = svf(300, 3)
      const d = t1 - t0
      let ph = 0
      put(t0, d, (tt) => {
        const u = tt / d
        ph += (200 + 1800 * u * u) / SR
        return (bp(noise(), 300 + 6000 * u * u) * 1.6 + Math.sin(2 * Math.PI * ph) * 0.15) * u * u
      }, { g, rev: 0.35, group: 'fx' })
    },

    /** 关机音：220 Hz 起，频率按 (1-u)² 塌陷。段落结束、画面收回。 */
    powerDown(t, d = 0.28, g = 0.25) {
      let ph = 0
      put(t, d, (tt) => {
        const u = tt / d
        ph += 220 * Math.pow(1 - u, 2) / SR
        return (Math.sin(2 * Math.PI * ph) + 0.4 * ((ph % 1) * 2 - 1)) * (1 - u)
      }, { g, rev: 0.15, group: 'fx' })
    },

    /** 搓盘：带通中心被 3 次正弦来回扫。给"卡住/倒回"这种动作配音。 */
    scratch(t, d = 0.25, g = 0.25) {
      const bp = svf(1200, 4)
      put(t, d, (tt) => {
        const u = tt / d
        return bp(noise(), 400 + 3000 * Math.abs(Math.sin(u * Math.PI * 3))) * (1 - u) * 2
      }, { g, rev: 0.1, group: 'fx' })
    },

    /** 金属撞击：三个不成整数比的方波（1 / 2.76 / 5.4），非谐波才有"铁"味。 */
    metal(t, g = 0.2, d = 0.5, base = 220) {
      const h = [1, 2.76, 5.4, 8.9]
      put(t, d * 3, (tt) => {
        let s = 0
        for (let i = 0; i < h.length; i++) {
          s += Math.sign(Math.sin(2 * Math.PI * base * h[i] * tt)) / (i + 1)
        }
        return s * env(tt, 0.001, d)
      }, { g, rev: 0.35, group: 'fx' })
    },

    /** 正弦扫频：从 f0 到 f1 的纯音，做 UI 转场、加载条。 */
    sweep(t, dur, f0, f1, g = 0.12, pan = 0) {
      let ph = 0
      put(t, dur, (tt) => {
        const u = tt / dur
        ph += (f0 + (f1 - f0) * u) / SR
        return Math.sin(2 * Math.PI * ph) * Math.pow(Math.sin(Math.PI * u), 1.6)
      }, { g, pan, rev: 0.2, group: 'fx' })
    },

    /** 反向的声音：给一段包络从 0 爬到满，然后一刀切断。用在下一击的前一拍。 */
    reverse(t, dur, f, g = 0.15) {
      const bp = svf(f, 3)
      put(t, dur, (tt) => {
        const u = tt / dur
        return bp(noise()) * Math.pow(u, 4) * (1 - Math.min(1, Math.max(0, (u - 0.97) / 0.03)))
      }, { g, rev: 0.3, group: 'fx' })
    },
  }

  /** 组合音：一次落点同时给底鼓 + 超低音 + 吊镲。写谱时最常用的"重击"。 */
  V.impact = (t, g = 1) => {
    V.kick(t, 1.1 * g)
    V.sub(t, 29, 1.6, 0.5 * g)
    V.crash(t, 0.2 * g, 0.7)
  }

  /** 组合音：低沉的"咚"，比 impact 轻，用于元素落位。 */
  V.thud = (t, g = 0.5) => {
    V.kick(t, 0.7 * g, { tune: 0.75, decay: 0.1 })
    V.tom(t, 45, 0.25 * g)
  }

  // ============================================================ 混响

  /**
   * Freeverb：6 个梳状滤波器（并联）+ 3 个全通（串联）。
   * 左右用不同 offset 让两个声道的尾音不相关 —— 否则混响听起来像单声道。
   */
  function reverb(input, offset = 0) {
    const out = new Float32Array(N * CH)
    const combs = [1557, 1617, 1491, 1422, 1277, 1356].map((d) => ({
      b: new Float32Array(Math.round((d + offset) * SR / 44100)), i: 0, lp: 0,
    }))
    const aps = [556, 441, 341].map((d) => ({
      b: new Float32Array(Math.round((d + offset) * SR / 44100)), i: 0,
    }))
    for (let n = 0; n < N; n++) {
      for (let c = 0; c < CH; c++) {
        const x = input[n * CH + c]
        let s = 0
        for (const cb of combs) {
          const y = cb.b[cb.i]
          cb.lp = y * 0.75 + cb.lp * 0.25
          cb.b[cb.i] = x + cb.lp * 0.83
          cb.i = (cb.i + 1) % cb.b.length
          s += y
        }
        for (const ap of aps) {
          const bo = ap.b[ap.i]
          const y = -s + bo
          ap.b[ap.i] = s + bo * 0.5
          ap.i = (ap.i + 1) % ap.b.length
          s = y
        }
        out[n * CH + c] = s * 0.1
      }
    }
    return out
  }

  // ============================================================ 母带

  /**
   * 混音到母带。
   *
   * 顺序是刻意的：
   *   1. 分组增益（调平衡）
   *   2. 加混响回送（湿声在同一总线上）
   *   3. tanh 软限幅（超过 1 也不硬切，压成圆角）
   *   4. 归一化到目标峰值（默认 -1 dBFS）
   *   5. 首尾淡入淡出（去掉爆音）
   *
   * 不做动态压缩。视频音效不需要响度战，需要的是"每个点都听得见"，
   * 而压缩会把稀有的重击和普通的点击拉平。
   */
  function master({ peak = 0.89, fadeIn = 0.005, fadeOut = 0.4, softClip = 1.1, wet = 0.9 } = {}) {
    // 把所有分组的湿声汇总成一条 send，再跑两遍混响（左右不同 offset → 去相关）
    const sendSum = new Float32Array(N * CH)
    for (const g of GROUPS) {
      const gg = groupGain[g] ?? 1
      const s = send[g]
      for (let i = 0; i < N * CH; i++) sendSum[i] += s[i] * gg
    }
    const wetL = reverb(sendSum, 0)
    const wetR = stereo ? reverb(sendSum, 23) : null

    let p = 0
    for (let n = 0; n < N; n++) {
      for (let c = 0; c < CH; c++) {
        const i = n * CH + c
        const g = GROUPS.reduce((a, gr) => a + dry[gr][i] * (groupGain[gr] ?? 1), 0)
        const w = (c === 0 ? wetL[i] : (wetR || wetL)[i]) * wet
        const v = Math.tanh((g + w) * softClip)
        if (c === 0) masterL[n] = v
        else masterR[n] = v
        p = Math.max(p, Math.abs(v))
      }
    }

    const gain = p > 0 ? peak / p : 1
    const nIn = Math.round(fadeIn * SR)
    const nOut = Math.round(fadeOut * SR)
    for (let n = 0; n < N; n++) {
      let f = 1
      if (nIn > 0 && n < nIn) f = n / nIn
      if (nOut > 0 && n > N - nOut) f = Math.min(f, (N - n) / nOut)
      masterL[n] = Math.max(-1, Math.min(1, masterL[n] * gain * f))
      if (stereo) masterR[n] = Math.max(-1, Math.min(1, masterR[n] * gain * f))
    }

    return { L: masterL, R: stereo ? masterR : masterL, peakBefore: p, gain }
  }

  /** 导出 16-bit PCM 的 WAV 字节。手写 RIFF 头，不依赖任何库。 */
  function toWav({ L, R }, { bitDepth = 16 } = {}) {
    const bytes = bitDepth / 8
    const dataSize = N * CH * bytes
    const buf = Buffer.alloc(44 + dataSize)
    buf.write('RIFF', 0)
    buf.writeUInt32LE(36 + dataSize, 4)
    buf.write('WAVE', 8)
    buf.write('fmt ', 12)
    buf.writeUInt32LE(16, 16)          // fmt chunk 大小
    buf.writeUInt16LE(1, 20)           // PCM
    buf.writeUInt16LE(CH, 22)
    buf.writeUInt32LE(SR, 24)
    buf.writeUInt32LE(SR * CH * bytes, 28)  // byte rate
    buf.writeUInt16LE(CH * bytes, 32)  // block align
    buf.writeUInt16LE(bitDepth, 34)
    buf.write('data', 36)
    buf.writeUInt32LE(dataSize, 40)
    for (let n = 0; n < N; n++) {
      const l = Math.round(Math.max(-1, Math.min(1, L[n])) * 32767)
      if (CH === 2) {
        const r = Math.round(Math.max(-1, Math.min(1, R[n])) * 32767)
        buf.writeInt16LE(l, 44 + n * 4)
        buf.writeInt16LE(r, 46 + n * 4)
      } else {
        buf.writeInt16LE(l, 44 + n * 2)
      }
    }
    return buf
  }

  return {
    SR, N, CH, duration,
    V, CHORDS, chord, mtof, noteToFreq, toMidi,
    put, rnd, noise, env, svf, reverb, master, toWav,
    groupGain,
    /** 直接改某个分组的整体电平，返回自身便于链式 */
    setGroup(name, gain) { if (name in groupGain) groupGain[name] = gain; return this },
    /** 剩余可用时间：写谱时防止最后一个音被时长截断 */
    roomAt(t) { return Math.max(0, duration - t) },
  }
}

export default createSynth
