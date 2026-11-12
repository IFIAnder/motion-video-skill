# 用代码算音频：配方与时间轴

> **默认规则：自己造，不找素材。**
> 只有用户**明确点名**了某个文件 / 曲目 / 素材库（"用这个 mp3""配这首曲子""声音在 assets/x.wav"）
> 才用素材。"加点声音""要音效""片头配乐""听起来专业一点"这类说法都**不是**指定素材，一律自己算。
> 即使用户指定了素材，交付前也要跑一次 `audiocheck`——素材本身可能有削波、静音段、时长不符。

> 视频那边我们靠 `seek(t)` 把画面变成纯函数，所以能逐帧重现、能被机器判定。
> 音频如果去下载素材，这三样立刻全丢：**不可重现、不可对拍、不可微调**。
> 一段 4.2s 落下的"叮"，算出来的就能挪到 4.35s 再算一遍；mp3 只能导进编辑器手动拖。

`scripts/synth.mjs` + `scripts/audio.mjs` 就是这件事的全部工具。零依赖、确定性、
采样精确（输出逐采样可复现，`--seed` 固定时同一份场景永远同一个 WAV）。

---

## 一、先想时间轴，再想声音

写音频的顺序和写画面一样：**先列事件表，再选音色**。

```
t      画面                               声音
0.0    标题从下方推入                      whoosh 400→1800、pad 起
0.6    标题落位                            tick（轻）
1.8    第一个方块从左侧飞入并砸下          impact（重）+ 短 sub
2.0    方块开始滑动                        bass 每拍
2.4    第二个方块落位                      tick
3.4    整屏收缩                            whoosh swell 500→4000（末端最响）
4.0    新章节标题出现                      impact + bell 两个音
4.4-5.0 六个小圆点依次亮起                 tick ×6 + blip 上行
6.4    收尾                               bell 长尾 + sub
8.0    结束                               尾部 0.4s 淡出
```

这张表转成代码就是一份 `audio-scene.mjs`。**表里没写声音的时刻，就不要有声音**——
持续铺底是"没有编曲"的最大特征，`audiocheck` 会以 `[flat] 动态范围 < 3 dB` 报出来。

---

## 二、层次：四条总线，四个不同的音量域

`synth` 内部把声音分到四条总线：`drum` / `bass` / `music` / `fx`。
默认增益都是 1，但**每个 voice 的 `g` 参数本身已经隐含了合适的量级**，
照着下表用就不会糊：

| voice | 典型 `g` | 什么时候用 |
| --- | --- | --- |
| `pad` | 0.04 – 0.06 | 全程垫底。超过 0.08 会把其他声音埋掉 |
| `kick` | 0.55 – 0.9 | 每拍或每个重音 |
| `clap` | 0.25 – 0.4 | 2、4 拍，或"落位"的替代 |
| `hat` | 0.10 – 0.16 | 反拍、十六分音符。超过 0.2 会刺耳 |
| `bass` | 0.10 – 0.18 | 跟 kick 同步，或走反拍 |
| `sub` | 0.3 – 0.5 | 只跟 impact 用，单独用会浑浊 |
| `bell` | 0.06 – 0.12 | 每个重要节点 1–2 个音，不要连成旋律 |
| `blip` | 0.05 – 0.10 | 琶音、UI 反馈。密集使用时压到 0.05 |
| `pluck` | 0.05 – 0.15 | 分解和弦，比 blip 更有"弦"味 |
| `tick` | 0.12 – 0.30 | 文字逐字、网格逐格。**这是最常用的声音** |
| `click` | 0.06 – 0.12 | 最轻的 UI 反馈，密集也不糊 |
| `whoosh` | 0.10 – 0.25 | 转场前后 0.3–0.7s |
| `riser` | 0.10 – 0.16 | 转场前 1–2s，把注意力拉起来 |
| `impact` | 0.8 – 1.2 | 章节起点。**全片只有 3–6 次** |
| `crash` | 0.15 – 0.25 | 收尾或最大的一击 |

`impact` 是 `kick + sub + crash` 的组合。它很响，所以**用得越少越有效**。
一个 8 秒片头有 3 次就够了；每 2 秒来一次等于没有重音。

调平衡不用改二十处调用：

```js
s.setGroup('drum', 0.8)   // 整体把鼓压 3 dB
```

---

## 三、六个可直接抄的配方

### 1. 8 秒片头（最常用）

```js
export const duration = 8
export function render(s) {
  // 和声：Fm → Db → Ab，每 2 秒一次。pad 是"调性"，不是"旋律"
  const prog = [['F3','min'], ['D#3','maj'], ['G#2','maj'], ['A#2','maj']]
  for (let b = 0; b * 2 < 8; b++) {
    const [root, q] = prog[Math.min(prog.length - 1, b)]
    s.V.pad(b * 2, Math.min(8, b * 2 + 2.2), s.chord(root, q), 0.05, 1200 + b * 200)
  }

  s.V.riser(0, 1.8, 0.14)          // 0→1.8s 上升，引出第一击
  s.V.impact(1.8, 1)               // 第一击

  // 鼓：1.8s 起，每拍一下，第 3 拍加 clap
  for (let t = 2.0, i = 0; t < 6.8; t += 0.5, i++) {
    s.V.kick(t, i % 4 === 0 ? 0.85 : 0.55)
    if (i % 4 === 2) s.V.clap(t, 0.28)
    s.V.hat(t + 0.25, 0.12, 0.03, i % 2 ? 0.25 : -0.25)
    s.V.bass(t, s.toMidi('F1') + [0,0,8,0][i % 4], 0.18, 0.13)
  }

  s.V.whoosh(3.4, 0.6, 500, 4000, 0.16, 0, 'swell')   // 末端最响，引出 4.0
  s.V.impact(4.0, 0.9)
  s.V.bell(4.02, 89, 0.9, 0.10)
  s.V.bell(4.06, 96, 0.9, 0.07, 0.35)

  // 细碎音：像 UI 元素依次落位
  for (let i = 0; i < 6; i++) {
    s.V.tick(4.4 + i * 0.08, 84 + i * 2, 0.16, (i % 2 ? 0.3 : -0.3))
    s.V.blip(4.45 + i * 0.08, s.toMidi('F5') + [0,3,5,7,10,12][i], 0.06, 0.08, (i - 2.5) * 0.25)
  }

  s.V.whoosh(5.6, 0.7, 3000, 400, 0.14)
  s.V.bell(6.4, 77, 1.6, 0.08)
  s.V.kick(6.4, 0.6)
  s.V.sub(6.4, 29, 1.2, 0.3)
}
```

### 2. UI 操作演示（20–40 秒，不能吵）

关键是**密度低、音量小、只用高频**。观众要听讲解，音效只是"点一下"。

```js
export const duration = 24
export function render(s) {
  s.V.pad(0, 24, s.chord('C3', 'maj9'), 0.025, 800)   // 几乎听不见的底
  // 每次点击：click 一声，不要 blip（blip 有音高，会干扰注意力）
  const clicks = [1.2, 2.8, 5.1, 7.4, 9.0, 12.3, 15.6, 18.2, 21.0]
  clicks.forEach((t, i) => s.V.click(t, 0.10, i % 2 ? 0.25 : -0.25))
  // 每次页面切换：短 whoosh，不要 riser
  const navs = [4.0, 11.0, 17.5]
  navs.forEach((t) => s.V.whoosh(t - 0.3, 0.35, 800, 2400, 0.10))
  // 成功完成：一个三音上行
  ;[0, 4, 7].forEach((iv, i) => s.V.blip(22.0 + i * 0.07, s.toMidi('C5') + iv, 0.08, 0.09))
}
```

### 3. 数据动效（图表长出来）

数据类声音要"有节奏但不音乐化"——用 tick 跟随数据点落位，用 sweep 表示增减。

```js
export function render(s) {
  s.V.pad(0, 6, s.chord('A2', 'min7'), 0.03, 900)
  // 柱子依次长出：每根一个 tick，音高随数值升高
  const values = [0.3, 0.55, 0.42, 0.78, 0.66, 0.9]
  values.forEach((v, i) => {
    const t = 1.0 + i * 0.12
    s.V.tick(t, 72 + Math.round(v * 24), 0.2, (i - 2.5) * 0.3)  // 高柱子音更高
    s.V.hat(t + 0.01, 0.05, 0.02, (i - 2.5) * 0.3)
  })
  // 总数出现：一个 bell
  s.V.bell(2.2, 84, 1.0, 0.10)
  s.V.whoosh(3.0, 0.5, 1200, 600, 0.12)
}
```

### 4. 循环动图（1–3 秒，必须能无缝接）

循环的音效**首尾必须接得上**，否则每次循环都"啪"一下。做法：所有周期性声音用
`t / duration` 的相位，并保证 `f(0) === f(duration)`。

```js
export const duration = 2
export function render(s) {
  // 两拍正好铺满 2 秒；不要用 whoosh（它的包络首尾都不为零）
  for (let i = 0; i < 4; i++) {
    s.V.kick(i * 0.5, 0.6)
    s.V.hat(i * 0.5 + 0.25, 0.10, 0.03, i % 2 ? 0.2 : -0.2)
  }
  // pad 在 duration 处正好回到起点相位
  s.V.pad(0, 2, s.chord('F3', 'min'), 0.04, 1000)
}
```

导出后用 `audiocheck --loop` 思路核对：把首尾 50ms 的 RMS 比一下，差太多就是接缝没对上。

### 5. 转场音效（独立 WAV，可复用）

一次转场 = `whoosh` + 落点 `impact`。做成独立文件便于反复使用：

```js
export const duration = 1.2
export function render(s) {
  s.V.whoosh(0, 0.9, 400, 4000, 0.20, 0, 'swell')  // 0→0.9s 渐强
  s.V.impact(0.92, 0.8)                             // 落点
  s.V.bell(0.94, 89, 0.8, 0.08)
}
```

`whoosh` 的 `shape` 参数很关键：

- `'bell'`（默认）：中间最响，用于"经过"
- `'swell'`：末端最响，用于"引出下一击"。**90% 的转场应该用 swell**

### 6. 纯氛围底（做讲解、长时间停留）

```js
export const duration = 30
export function render(s) {
  // 慢和声：每 6 秒换一次，比每 2 秒更"稳"
  const prog = [['D3','min7'], ['A#2','maj9'], ['F3','maj7'], ['C3','sus2'], ['D3','min7']]
  prog.forEach(([root, q], i) => {
    s.V.pad(i * 6, i * 6 + 6.4, s.chord(root, q), 0.03, 700)
  })
  // 每 6 秒一个极轻的 bell，标出段落（不给节拍，避免抢注意力）
  prog.forEach((_, i) => { if (i > 0) s.V.bell(i * 6, 77, 2.0, 0.05) })
}
```

---

## 四、和弦与音高：不要手算

```js
s.chord('F3', 'min')        // → [53, 56, 60]
s.chord('D#3', 'maj9')      // → [51, 55, 58, 62, 65]
s.chord('G#2', 'sus4', 1)   // 高一个八度
s.toMidi('A4')              // → 69
s.mtof(69)                  // → 440
s.noteToFreq('C4')          // → 261.63

// 可用品质：maj min dim aug sus2 sus4 maj7 min7 dom7 maj9 min9 add9 min6
```

**五声音阶最安全**：`[0, 3, 5, 7, 10]` 或 `[0, 2, 5, 7, 9]` 的任意组合都不会难听。
不确定调性时，用 minor pentatonic 走琶音，比硬套三和弦更不容易出错。

---

## 五、整条流水线

```bash
# 1. 算音频（场景文件里写谱）
node scripts/audio.mjs --scene audio-scene.mjs --out out/audio.wav --duration 8

# 2. 音频验收（这一步别跳）
node scripts/audiocheck.mjs --wav out/audio.wav --duration 8

# 3. 渲染视频（此刻应该已经过了 audit）
node scripts/render.mjs --html scene.html --out out/v.mp4 --motion-blur 180

# 4. 合流（合完自动复核）
node scripts/mux.mjs --video out/v.mp4 --audio out/audio.wav --out out/final.mp4

# 5. 对**成品**再验一次音频（合流也可能改坏东西）
node scripts/audiocheck.mjs --wav out/final.mp4 --video out/v.mp4
```

第 4 步的 `mux.mjs` 会在合流**之前**核对音画时长，合流**之后**重新 probe 两条流。
它不信任"命令返回 0 就是成功"。

---

## 六、常见错误

| 症状 | 原因 | 修 |
| --- | --- | --- |
| `FAIL [silent] 整段没有声音` | 没调用任何 `V.*`，或时长算成 0 | 检查 `render(s)` 里是否真的写了声音 |
| `FAIL [clip] N 个采样贴满刻度` | 归一化目标太高，或声音叠太多 | `--peak 0.85`；或 `setGroup('drum', 0.8)` |
| `WARN [flat] 动态范围 < 3 dB` | 从头到尾一个响度 | 加留白、加 impact、去掉多余的持续 pad |
| `WARN [silence] 中段静音 2.3–3.1s` | 那一段漏写了 | 要么补 pad，要么把音效挪进来 |
| `WARN [edge] 开头/结尾有爆音` | 没淡入淡出 | 默认有 5ms 淡入 + 0.4s 淡出，别关掉 |
| `WARN [quiet] 峰值只有 -21 dBFS` | 归一化没生效或 `--peak` 设低了 | `--peak 0.89`（约 -1 dBFS） |
| `INFO [stereo] 相关性 1.0000` | 所有 voice 的 pan 都是 0 | 给 hat/tick 交替 pan ±0.25 |
| 音效总比画面慢半拍 | 谱子里写的时间点就是画面落点 | 音头要**提前** 20–40ms 起，人对声音的反应比对画面快 |
| 合流后尾音被切 | 音频比视频长 | 让 `duration` 等于视频时长；尾音用 1.5s 内能衰减完的 voice |

---

## 七、为什么这样能接近"专业音效"

不是因为公式多高级，而是因为**三件专业做法被自动化了**：

1. **分层**：底鼓负责低频冲击、踩镲负责高频时间感、pad 负责调性、fx 负责事件。
   四层各管一段频率，混起来自然有空间感。手写音频最容易犯的错就是"一个声音干所有事"。
2. **时间精确到采样**：`4.000s` 就是 `4.000s`。素材库里的音效总有前后留白，
   拼接时永远差几十毫秒，而人对 30ms 的音画不同步就能察觉。
3. **可迭代**：改一个参数重算 8 秒音频只要 300ms。这个速度允许你"试十版"。

真正的上限在于你怎么设计时间轴 —— 那是编曲，不是合成。
`synth` 只保证"你写下的那一刻，确实响了那一下"。
