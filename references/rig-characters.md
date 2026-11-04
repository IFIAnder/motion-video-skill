# 角色与骨骼：把"部件 + rig"变成能演的动作

前面几份文档解决的是"没有故事板、只有文字和图形"的问题。这一份解决另一件事：
**画面里有个角色，它要动起来**——而且是那种有预备、有回弹、有跟随的动，不是平移缩放。

## 第一原则：有现成 rig 就用，一个数值都不许重估

**这是踩过真实事故的一条，写在最前面。**

事故记录：某次任务里，工作空间已经有上游拼好的 `rig/ander.rig.json`（4 根骨 + 24 部件，
注释写明 "Rest pose fitted to the assembled reference by template matching at global scale 1.37"）。
执行方没有用它，而是照着部件清单 `_manifest.json` 的 `x/y/w/h` **自己重估了一套**：

| 字段 | 现成的 | 重估的 | 偏差 | 后果 |
| --- | --- | --- | --- | --- |
| `head.pos` | `[-6.8, -182.5]` | `[0, -248]` | 65.9px | 头飘到身体左上方 |
| `torso.pv` | `[160, 160]` | `[160, 291]` | 131px | 整件上衣绕衣摆转 |
| `headimg.pv` | `[112, 112]` | `[111.5, 204]` | 92px | 头绕下巴转 |
| `armA_R.rot` | `-0.197` | 丢弃（0） | — | 静止姿态就错 |
| `hair_back.sc` | `1.12` | 丢弃（1） | — | 发量变小 |

成品里角色**头和身体分离**，而"看图检查"通过了——因为人眼（和模型的眼睛）看角色图时先验是
"这是个人形"，会自动忽略几十像素的错位。

**所以规矩是：**

1. 动手前先搜工作空间有没有 `*.rig.json` / `manifest` / `_说明.md` / 上一版工程。
   有 → **整套沿用**，包括 `pv`、`pos`、`rot`、`sc`、`z`、`feet`、`eyes`。
2. 用 `rigcheck.mjs --ref` 把"我确实用的是原值"变成一条命令的结论：
   ```bash
   node scripts/rigcheck.mjs --rig my-rig.json --ref rig/ander.rig.json
   ```
   有 FAIL 就不许往下走。
3. 那些 `pos` **不是估出来的**，是模板匹配拟合到参考图上的。重估等于把美术的工作扔掉。
4. 只有这三种情况才允许改 rig，且要在 storyboard 里写明理由：
   - 原 rig 缺一个我要用的部件
   - 原 rig 的坐标空间不同（例如以脚底为原点 vs 以胯为原点）
   - 原 rig 明确是错的（有证据，不是"看着不像"）

`rigcheck.mjs` 还查内部一致性：父节点存在、无环、`pv` 落在画布内、`head.y < chest.y < hip.y < root.y`、
左右成对件是否被放到了同一侧、`--assert` 检查 pose 下骨长是否守恒（刚性关节链不该变长）。

## 先纠正一个常见误判

"角色动画做不了"是错的。做不了的是**写实的人体动力学**。风格化的 2D 角色
（纸片木偶 / 部件拼接 / Q 版）完全可以用 Canvas 做，而且比想象中简单：

> **角色 = 一堆按 z 排序的 PNG 部件 + 一套父子变换链 + 一组 pose 数据。**

三个要素，没有一个需要 3D、物理引擎或专业动画软件。

## 素材要求

- 一个角色的部件切图，命名固定（`head.png` `hair_back.png` `armA_L.png` `leg_R.png` …）
- 每张 PNG 是**同一画布尺寸**、各部件在原位对齐（做素材时对齐，别在代码里对）
- 部件数量：Q 版 12–24 个够，写实 40+ 才有细节

## 数据结构：`*.rig.json`

```json
{
  "feet": 470,
  "images": "./parts/",
  "bones": {
    "root":  { "pos": [960, 470] },
    "hip":   { "parent": "root", "pos": [0, -150] },
    "chest": { "parent": "hip",  "pos": [0, -60] },
    "head":  { "parent": "chest","pos": [0, -70] },
    "armA_L":{ "parent": "chest","pos": [-34, -20] },
    "armB_L":{ "parent": "armA_L","pos": [0, 52] }
  },
  "parts": {
    "leg_L":  { "img": "leg_L",  "z": 10, "parent": "hip", "pos": [-18, 0], "pv": [40, 160] },
    "torso":  { "img": "torso",  "z": 40, "parent": "chest", "pos": [0, 0], "pv": [80, 110] },
    "headimg":{ "img": "head",   "z": 60, "parent": "head",  "pos": [0, -20], "pv": [64, 70] }
  },
  "skinSample": [30, 30]
}
```

三个关键字段，错一个姿势就会歪：

- **`pos`**：这个节点相对父节点的枢轴位置。骨骼是链，`pos` 是关节偏移。
- **`pv`**：部件的**枢轴点**（pivot），在图片自身坐标系里。旋转绕它转。
  肩在肩膀、腿在胯、头在颈——`pv` 填错，手臂就会绕手腕转。
- **`z`**：绘制顺序。`hair_back` 最小（最后面），`headimg` 中等，`bangs` 最大（盖住脸）。

## 求解：父子链 → 世界矩阵

```js
function solve(rig, pose = {}) {
  const mats = {}
  const get = (name) => {
    if (mats[name]) return mats[name]
    const n = rig.nodes[name], p = pose[name] || {}
    const parent = n.parent ? get(n.parent) : new DOMMatrix()
    const m = parent
      .translate(n.pos[0] + (p.dx || 0), n.pos[1] + (p.dy || 0))
      .rotate(((n.rot || 0) + (p.rot || 0)) * 180 / Math.PI)
      .scale((n.sc ?? 1) * (p.sx ?? 1), (n.sc ?? 1) * (p.sy ?? 1))
    return (mats[name] = m)
  }
  Object.keys(rig.nodes).forEach(get)
  return mats
}
```

`DOMMatrix` 在浏览器里可用，链式乘法天然处理父子关系。**这是整个骨骼系统的全部数学。**

## 绘制：按 z 排序 + 枢轴偏移

```js
function draw(ctx, rig, imgs, pose, opts = {}) {
  const mats = solve(rig, pose)
  const base = ctx.getTransform()
  for (const name of rig.order) {                 // 已按 z 升序排好
    const P = rig.parts[name], im = imgs[P.img]
    let M = mats[name]
    if (opts.world) { M = opts.world(name, M); if (!M) continue }  // 逐部件钩子
    const a = opts.alpha?.[name] ?? 1
    if (a <= 0) continue
    ctx.setTransform(base.multiply(M))
    ctx.globalAlpha = a
    ctx.drawImage(im, -P.pv[0], -P.pv[1])         // 枢轴放在原点
  }
  ctx.setTransform(base)
  ctx.globalAlpha = 1
  return mats
}
```

`opts.world(name, M)` 是整个设计里最灵活的地方：你能对单个部件做额外变换（倾斜、抖动、
镜像、给头发加跟随延迟），而不改动骨骼数据。

## pose：纯数据，所以天生适配 `seek(t)`

```js
const pose = {
  root:   { sy: 0.92 },                 // 全身挤压
  chest:  { rot: -0.12 },               // 前倾
  armA_R: { rot: -1.9 },                // 抬右臂
  armB_R: { rot: 0.4 },                 // 小臂跟随
  head:   { rot: 0.08 },
}
```

**pose 是相对 rest 的偏移**，不是绝对值。这意味着：

- 可以在任意时刻叠加（呼吸 + 动作 + 口型，各自只关心自己的通道）
- 可以整体插值：`mixPose(a, b, k)`
- **天然是 `t` 的纯函数**，直接进 `seek(t)`，不需要任何状态机

```js
seek(t) {
  const k = easeOutCubic(seg(t, 0.4, 1.0))
  Rig.draw(g, imgs, mixPose(REST, HERO, k), { glintAll: seg(t, 1.0, 1.2) * 0.6 })
}
```

## 把 12 条动画原则翻译成 pose

这是"角色看起来在演"而不是"被拖着走"的关键。每一条都有对应的字段：

| 原则 | 做法 | 字段 |
| --- | --- | --- |
| **Anticipation 预备** | 主动作前先反向 0.12–0.2s | 起跳前 `root.sy 1 → 0.88`，`chest.rot` 前倾 |
| **Squash & Stretch 挤压拉伸** | 着地压扁、腾空拉长，体积守恒 | 落地 `root.sy 0.82 / sx 1.12`；腾空 `sy 1.1 / sx 0.95` |
| **Arcs 弧线** | 肢体走曲线不走直线 | 手臂 `rot` 配 `chest.rot` 同向偏转，末端画弧 |
| **Follow-through 跟随** | 子级比父级晚 1–2 帧到达 | `armB` 的 k 用 `seg(t, t0+0.05, t1+0.05)` |
| **Overlap 重叠** | 头发/尾巴/衣服独立延迟 | `tail` 用 `ring(dt, f, decay)` 回弹 |
| **Slow in/out** | 关键姿态用 `inOutCubic`，打击用 `inQuad` | 曲线选择 |
| **Exaggeration 夸张** | 数值超出真实，但姿态对 | 过冲 ≤ 15%，再大就廉价 |
| **Staging 构图** | 动作朝画面空的一侧 | 由镜头决定，不是 pose |
| **Timing 节奏** | 快慢对比比绝对速度重要 | 起跳 0.25s、滞空 0.4s、落地 0.15s |
| **Secondary action 次级** | 眨眼、呼吸、发梢 | 加在 `world()` 钩子里，幅度 2–4% |

一个可用的"跳"时间轴（够开工）：

```js
const J = { squat: 0.60, takeoff: 0.85, apex: 1.05, land: 1.30, settle: 1.70 }
// 0.00–0.60  站 → 预蹲（squat），easeInOutCubic
// 0.60–0.85  预蹲 → 蹬伸（stretch），easeInQuad（快）
// 0.85–1.30  腾空 → 落地（squash），前半 easeOutQuad 后半 easeInQuad
// 1.30–1.70  回弹 → 站（overlap，用 spring 而非固定曲线）
```

**不要用一条曲线管整段动作。** 分四段，每段一条曲线，这是节奏感的来源。

## 弹簧与回弹：`spring(f, z)` 比 stiffness/damping 好写

```js
// 阻尼阶跃响应：0 → 1，带过冲。dt 是距动作开始的秒数
const spring = (dt, f = 3, z = 0.35) => {
  if (dt <= 0) return 0
  const w = 2 * Math.PI * f, wd = w * Math.sqrt(1 - z * z)
  return 1 - Math.exp(-z * w * dt) * (Math.cos(wd * dt) + (z * w / wd) * Math.sin(wd * dt))
}
// 阻尼振荡冲激：从 1 开始衰减振荡，用于发梢/尾巴
const ring = (dt, f = 3, decay = 6) => dt < 0 ? 0 : Math.exp(-decay * dt) * Math.cos(2 * Math.PI * f * dt)
```

- `f` = 每秒振荡次数（2–4 是"软弹"，6+ 是"硬弹"）
- `z` = 阻尼比（0.2 强回弹、0.35 自然、0.7 几乎不回弹）

`ring()` 用于**跟随件**：主件停下时，发梢还在按 `ring` 衰减振荡 —— 这是"活着"的观感来源。

## 素材没有怎么办

- 只有一张立绘：按关节位置切图（PS/脚本都行），或者用 `clip-path` 把同一张图分区域绘制
- 完全没有素材：用几何部件（头=圆、身体=圆角矩形、四肢=胶囊）搭一个"无脸人"，
  风格化到"图标级"反而更安全
- 别用 emoji 当角色

## 检查清单

- [ ] 每个部件都有 `pv`，且枢轴落在关节上（旋转时不该出现"绕轴心转"
- [ ] `z` 序正确：后发 < 身体 < 前发 / 配件
- [ ] pose 只写偏移，不写绝对值（绝对值会让叠加失效）
- [ ] 子级（小臂、发梢）比父级晚 1–2 帧
- [ ] 挤压/拉伸成反比（`sy * sx ≈ 1`），否则看起来像被压扁的图片
- [ ] 用 `verify.mjs --select` 检查每个骨骼通道的轨迹（有没有中途停顿、有没有 NaN）
- [ ] 用 `--still` 抽三种姿态各一张看：T-pose / 主姿态 / 收尾，确认没有穿模

## 什么时候这不够用

- 需要**连续变形**（布料、软体、真正的 squash 弧面）→ Canvas 部件做不了，考虑 WebGL 网格
- 需要**写实人体**（骨骼解剖、肌肉滑动）→ 上 3D（Blender）或专业 2D 骨架工具
- 需要**口型同步** → 部件切换（3–5 个口型图）+ 音素时间表，仍在本文件范围内
