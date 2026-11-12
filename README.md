# motion-video · 用代码做能验收的动画

> 一个给**弱模型**（Flash / mini / turbo 级）用的动效、视频与配乐生产 skill。
> 目标不是"让模型写得更漂亮"，而是**把动画变成可被机器判定的工程物**——
> 让"我以为我写了动效"这件事，在交付前被机器拆穿。
> 声音同理：**先列事件表，再让合成器把波形算出来**，而不是去翻素材库。

零 npm 依赖。只需要 Chrome/Edge + ffmpeg + ffprobe + Node。
（ffprobe 只在 `audit` / `audiocheck` 校验分辨率、时长、采样率时用。缺了不会静默放行——声明了 `--width/--height/--duration` 就直接 FAIL，没声明则 WARN。算音频**不需要浏览器**，`audio.mjs` 是纯 Node。）

---

## 它解决什么问题

小模型能写 CSS 和 Canvas，但写出来的动画经常"看起来写了，其实没动"：

| 失败模式 | 症状 | 机器怎么抓 |
| --- | --- | --- |
| 只有首末帧 | 中间态被跳过，元素凭空出现 | `audit` 变化像素曲线 |
| 假缓动 | 曲线是拍的，不丝滑 | `ease.mjs` 打 ASCII 图看过冲/平台段 |
| 中段静止 | 入场做完就开始等，观众看到停滞 | `audit` 静止帧检测 |
| 硬跳/闪烁 | 元素瞬移、平帧闪烁 | `audit` 帧间差 + 灰度差双指标 |
| 角色部件错位 | 头飘在身体旁边，看图"看着像个人"就过了 | `rigcheck` 几何断言 |
| 交付放水 | audit 报 WARN 还是交了 | 铁律 + 拒绝放行的默认值 |

差距不是靠一句咒语补上的。是靠**规格先行 + `seek(t)` 纯函数 + 帧精确渲染 + 三层机器验收**。

---

## 三十秒开始

```bash
# 1. 安装（skill 目录）
git clone https://github.com/IFIAnder/motion-video-skill.git ~/.dsh/skills/motion-video

# 2. 体检：Chrome / ffmpeg / Node 是否就绪
node ~/.dsh/skills/motion-video/scripts/render.mjs --check

# 3. 跑一个自带示例，看它长什么样
cd ~/.dsh/skills/motion-video
node scripts/render.mjs --html examples/illustrated-scene.html --out /tmp/demo.mp4 --fps 30 --sheet
node scripts/audit.mjs --video /tmp/demo.mp4 --fps 30 --duration 3 --width 1920 --height 1080
```

`audit` 最后一行会给你 `PASS / WARN / FAIL` 和**具体是哪一帧、哪个指标越界**。

---

## 十个脚本

| 脚本 | 干什么 | 为什么需要它 |
| --- | --- | --- |
| `render.mjs` | 无头 Chrome 逐帧调 `seek(t)` 截图，ffmpeg 编码 | 帧精确：同一份代码永远同一帧 |
| `audit.mjs` | 变化像素曲线 / 局部灰度差 / 节奏条 / 分级结论 | 抓"没动、中段静止、硬跳、平帧、闪烁、循环接缝" |
| `verify.mjs` | 读浏览器真实计算样式，逐通道输出轨迹 | 比像素早一步，**能点名到元素和属性** |
| `ease.mjs` | 贝塞尔 / 弹簧 / 错开步长 / 对比度 / CSS `linear()` | **数值不许心算**，让工具算 |
| `rigcheck.mjs` | 骨骼几何断言 + 与参考 rig 逐部件对比 | 抓"头飘在身体旁边"这类眼睛看不出的错 |
| `lint-skill.mjs` | 校验 SKILL.md frontmatter | 防"引号写错 → 整个 skill 加载不了" |
| `synth.mjs` | 离线确定性合成器：23 个 voice、SVF 滤波、Freeverb、四条总线 | 声音**算得出来**才谈得上可重现、可对拍、可微调 |
| `audio.mjs` | 把音频场景（一份写谱文件）算成 WAV，300ms / 8 秒 | 和 `seek(t)` 同构：你只写"什么时刻发生什么" |
| `audiocheck.mjs` | 削波 / 静音段 / 动态范围 / 首尾爆音 / 音画时长 | 音频没法快速听完，这几件事只能靠机器 |
| `mux.mjs` | 音视频合流，**合之前核对、合之后重新 probe** | 合流是最容易"看着成功其实坏了"的一步 |

### 附加能力

- `--motion-blur 180`：真实 180° 快门（以 4 倍帧率渲染后按曝光窗平均）——"看起来顺"与"看起来像录屏"的分界
- `--guides`：关键帧叠加 100px 网格 / 80px 安全区 / 三分线 / 中心十字
- `--sheet`：直接产出 3×3 接触表
- `--alpha`：透明背景。**webp / apng / png 可靠**；webm 取决 ffmpeg 构建——本机实测 VP8/VP9 都会把 `yuva420p` 降级成 `yuv420p`，脚本会在编码后回读首帧校验，alpha 全 255 就当场报错并给出替代格式，不静默交付
- `--format mp4|webm|gif|webp|apng|png`、`--scale 2` 超采样
- 帧率优先级 `--fps` > `scene.fps` > 30（曾经写死 30，导致 `audit --fps` 把整条时间轴标错一倍）
- 单实例锁：并发起多个 Chrome 会互相抢 CPU，**锁住比放开更快**

---

## 九份文档（按需读，别一次全读）

| 文件 | 内容 |
| --- | --- |
| `references/wish-mode.md` | **许愿式创作**：一句话就要出片，四槽位推导、章节预算、不问用户 |
| `references/spec-and-prompt.md` | 规格表模板 + 三种可复制 prompt + 对付"不愿调工具"的模型 |
| `references/code-patterns.md` | `seek(t)` 范式、缓动库、`keys()` 关键帧表、`spring(f,z)`、20 种现代 CSS 效果 |
| `references/asset-recipes.md` | **20 类零依赖视觉片段**：光晕/扫光/颗粒/玻璃/霓虹/网格/插画/粒子/线框球/图表/图标集/散景/伪 3D |
| `references/rig-characters.md` | 部件骨骼：`rig.json` 结构、`solve/draw`、12 条动画原则怎么落到字段、**为什么不许重估现成 rig** |
| `references/cinema-grade.md` | 运动模糊、抗色带编码参数、暗角、HUD 系统、甩镜、帧率决策、长片组织、多 tab 提速 |
| `references/audio-recipes.md` | **六个可抄的音频配方**：片头 / UI 演示 / 数据动效 / 循环 / 转场 / 氛围；四条总线的音量域；和弦工具；整条流水线 |
| `references/review-checklist.md` | 人眼抽检清单 + 交付前逐条过 |
| `references/failure-modes.md` | 按 audit / audiocheck / verify 报错对号入座的修法 + 已知边界 |
| `references/delta-vs-opus.md` | 与强模型的差距拆解：哪些补得上、哪些补不上 |

---

## 三层回环

```
ease（算参数） → verify（查数字） → render（出图） → audit（查像素） → 人眼
   0.5s            秒级              8s/3s片          1s/片

audio（算波形） → audiocheck（查电平/时长） → mux（合流） → audiocheck 再验一次
   0.3s/8s片          1s/8s片                       0.2s
```

**越靠前的错越便宜。** 用便宜手段堵住能堵的问题：

- `ease` 抓"参数算错"：`silkIn` 在 0.75 后就有平台段 → 1.5 秒入场有 0.4 秒不动
- `verify` 抓"中间态丢了"：`#b.sx — 0–2s 数值完全不变，之后又继续变化`
- `audit` 抓"整帧在停"：`warn [static] 中段静止 1.10–2.57s`
- `rigcheck` 抓"骨骼错位"：`torso.pv 偏 131px`、`head.pos 偏 65.9px`
- `audiocheck` 抓"整片没声音 / 削波 45% / 动态范围 0 dB / 音画差 320ms"
- `mux` 抓"合流时被 -shortest 截掉尾音"：它在合之后重新 probe，不信返回码

---

## 关于「没有图像理解」的模型

有些模型（例如某些纯文本推理版本）**不能用 `read_image` 看图**。这套工具链的设计恰好有一条
不依赖视觉的通路——**所有判定都是数字，不是图片**：

| 不需要看图就能做 | 手段 |
| --- | --- |
| 参数是否正确 | `ease.mjs`（过冲/平台/稳定时间） |
| 元素是否真的在动 | `verify.mjs`（逐通道轨迹、幂等性） |
| 整帧是否停滞/硬跳/闪烁 | `audit.mjs`（纯统计，结论就是数字） |
| 骨骼是否错位 | `rigcheck.mjs`（几何断言 + 参考对比） |
| 文字是否可读 | `ease.mjs contrast` / `ramp`（WCAG 比值） |

| 必须有眼睛（人或视觉模型） | 为什么 |
| --- | --- |
| 构图好不好（重心、留白、层级） | 是审美判断，不是可计算约束 |
| 配色是否协调、风格是否统一 | 同上 |
| 视觉上的穿模/遮挡异常 | 几何检查只能覆盖"关节位置"，覆盖不了"看起来对不对" |
| 角色是否"好看" | 同上 |

**结论**：无视觉模型 + 这套工具 = 能做对"结构、运动、几何、可读性"，
但"美不美"必须由人（或带视觉的模型）兜最后一关。把 `--still` 抽出的图交给能看的人，
是这条通路的必要一步，不能省。

---

## 差距的真实构成（反推自一个 60 秒作品集级产物）

| 占比 | 内容 | 能不能补 |
| --- | --- | --- |
| **约七成** | 工程结构：HUD 系统、时间线常量表、180° 快门、骨骼 rig、编码参数、并行调度 | **照抄就行**，都在这个仓库里 |
| **约两成** | 执行精度：曲线选得准、节奏卡拍点、错开步长不糊、细节不穿模 | 三层回环专治这个 |
| **约一成** | 品味：选题、构图、母题 | 补不动，但可用"参考 + 复刻"绕过 |

详见 `references/delta-vs-opus.md`。

---

## 事故记录（为什么有这个仓库里的某些设计）

**① 骨骼错位却判"合格"**

一次真实任务里，角色头部相对身体偏了 65.9px、上衣枢轴偏 131px，成品是**头飘在旁边**。
`verify` 只查"有没有动"、`audit` 只查"帧间差异"、`--still` 看图——模型看角色图有"这是个人形"的
先验，会自动忽略几十像素的错位。三层全部失效。

→ 于是有了 `rigcheck.mjs`：把"看不出的错"变成"机器判定的错"（层级 y 顺序、左右对称、
`pv` 是否出画布、与参考 rig 的逐部件偏差）。

**② 84 分钟里有 72 分钟是浪费**

另一次，渲染脚本一次起了 4 个 node 进程，每个再起一个 Chrome，每个都开 4 倍子帧。
4 个 swiftshader 软件渲染抢同一个 CPU，比串行更慢。

→ 于是有了单实例锁。**并发不是免费的，等待并不等于质量。**

**③ `description` 里一个裸双引号，让整个 skill 变成 "unknown or no longer available"**

YAML 双引号字符串内部不能有未转义的 `"`。它会在第一个 `"` 处截断，frontmatter 解析失败，
且报错完全不说明原因。

→ 于是有了 `lint-skill.mjs`。

---

## 设计原则

1. **规格先行**：没有元素时间轴表（`enter` / `active` / `exit`）不许写代码。
2. **`seek(t)` 纯函数**：禁止 `rAF` / `Date.now()` / `Math.random()` / 自动跑的 `@keyframes`。
3. **数字归工具**：曲线参数、步长、对比度一律跑脚本，不许手写推断值。
4. **质量优先**：只省无效开销（并发、重复启动、冗余文档），**不省验证**（全量 audit、
   幂等检查、骨骼体检、交付版快门、60fps）。
5. **不许等素材**：渲染管线只有 HTML/CSS/SVG/Canvas，所有视觉元素自己画，禁止 emoji 当图标。
6. **既有资产优先**：有现成 rig / 规范 / 组件就整套沿用，用 `rigcheck --ref` 证明没改过。

---

## 环境

- Node ≥ 20（用到全局 `fetch` / `WebSocket`）
- Chrome 或 Edge（无头）
- ffmpeg（要有 `libx264`）
- 已知可用平台：Windows（主）、macOS / Linux（路径探测已内置，未充分测试）

---

## 许可

MIT。
