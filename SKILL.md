---
name: motion-video
description: '用代码做动画和视频：片头/动效/字幕动画/数据可视化动效/UI 演示/讲解片段/循环动图，输出 mp4/webm/gif/webp，并有机器验收回环保证「画面真的在动、没有丢中间态」。用户说「做个动画/动效/片头/开场/蒙太奇/动图/懒加载 banner/视频片段/演示动画/用代码生成视频/HTML 转视频/remotion 风格」，或要求把一段内容做成可以播放的片子时使用。不用于文生视频（云视频模型）、真人素材剪辑、配音配乐。'
---

# motion-video · 用代码做能验收的动画

这份 skill 解决一个很具体的问题：小模型（Flash / mini / turbo 类）能写 CSS 和 Canvas，
但写出来的动画经常"看起来写了，其实没动"——中间态被跳过、缓动是假的、
关键元素在别的时刻才出现、结尾停在半路。它自己看不出来，因为它没有眼睛。

所以这里的做法不是"教它写得更好看"，而是**把动画变成可被机器判定的工程物**：

1. 先规格、后代码 —— 把审美判断翻译成表格里的数值
2. 画面必须是 `t` 的纯函数 —— 从结构上强迫它写出中间态
3. **数字交给脚本算** —— 贝塞尔、弹簧、错开步长、对比度，一律跑工具，不心算
4. 用确定性渲染器逐帧出图 —— 同一份代码永远同一帧
5. 用机器验收 —— 数值层先验一遍，像素层再验一遍
6. 只在机器说"结构没问题"之后，才轮到人眼看构图

差距不是靠一句咒语补上的。是靠这六件事把"想不对"变成"可发现、可修"。
差距从哪来、哪些补得上、哪些补不上，见 [references/delta-vs-opus.md](references/delta-vs-opus.md)。

---

## 质量优先：只省无效开销，不省验证

**这条比下面的铁律更靠前。** 这个 skill 的目标是做出 Opus 级的片子，不是做出最便宜的片子。
所以"要不要做这件事"的判断标准**不是快不快，而是会不会更好**。

只有一类开销可以省：**重复的、无效的、互相抢资源的**。验证密度、渲染质量、帧率、
运动模糊——这些一律不省。

### 允许省（浪费，省了不加分也不减分）

| 浪费 | 省法 |
| --- | --- |
| 起 4 个 Chrome 并发抢 CPU | **串行**（实测比并发快），`render.mjs` 已内置单实例锁 |
| 每章一份 20KB 规格文档 | 一份 `storyboard.md` 写全 |
| 反复调 `render --still` 每次只抽一帧 | 一次抽 6–8 个时间点 |
| 同一素材反复重新分析 | 分析一次，结果写进 storyboard |
| 逐帧 PNG 落盘再读 | 已开 `optimizeForSpeed`；超大项目改 image2pipe（cinema-grade.md §9） |
| 为了"稳妥"把同一件事验证三遍 | 验证两遍（数值 + 像素）就够，第三遍加不出信息 |

### 禁止省（省了就是降质）

| 不许省 | 理由 |
| --- | --- |
| 全量 `audit`，含 jump / flat 逐条处理 | 交付前最后一关，跳过 = 没验收 |
| `verify --idempotent` | 幂等坏了，后面所有验证都不可信 |
| `rigcheck`（每次改角色或姿态） | 骨骼错位只能靠数字抓，眼睛抓不到 |
| **交付版开运动模糊** | 有没有快门的观感差一个档次，不是锦上添花 |
| **有快速运动时用 60fps** | 30fps 下快速肢体会顿，这是缺陷不是取舍 |
| 抽帧看图（多时刻 + 局部放大） | 1 张图看不出中段问题；至少 6 帧 + 关键部位 2–3× 放大 |
| 修完重跑（而不是"应该好了"） | 没重跑就等于没修 |

### 一句话判据

**省下的是等待时间，可以省；省下的是"发现错误的机会"，不能省。**

渲染 70 分钟不可接受，原因不是"70 分钟太长"，而是那 70 分钟里 85% 是 4 个进程在互相抢 CPU
——**等待没有换来任何质量**。而为了 180° 快门多花 4 倍渲染时间，换来的是实打实的观感提升
——**这笔必须花**。

### 正确的提速顺序

1. **先杀浪费**：并发改串行、合并重复启动、删冗余文档、批量抽帧
2. **再优化实现**：截图参数、单进程多 tab、不落盘直通编码
3. **最后才考虑减少验证** —— 而这一步基本不该发生；真发生了说明前面两步没做

---

## 铁律

违反任何一条，产物就是不可验收的，重做。

1. **没有规格不许写代码。** 先产出镜头表和时间轴表（STEP 1）。表格里每个元素必须有
   `enter` / `active` / `exit` 三个时间区间，缺一个就说明你还没想清楚它在什么时候存在。
   **但用户只给一句话时（"做个厉害的""展示你的能力""全力以赴"），不许反问他做访谈**——
   自己把母题/元叙事/形式/档位四个槽位填满并写进 `storyboard.md`，然后直接开工。
   见 [references/wish-mode.md](references/wish-mode.md)。
2. **所有画面状态是 `seek(t)` 的纯函数。** 禁止 `requestAnimationFrame`、`Date.now()`、
   `performance.now()`、`Math.random()`、自增计数器、以及自己会跑的 CSS `@keyframes`/`transition`。
   同一份代码同一个 `t`，必须永远渲染出同一像素。
3. **数值一律跑脚本，禁止心算。** 曲线控制点、弹簧参数、错开步长、坐标换算、对比度比值、
   `linear()` 串——全部由 `ease.mjs` 产出。你的回答里出现这类数字之前，必须先有一条工具输出。
   见下面「数字归工具，判断归你」。
4. **改完必须跑 `verify` 和 `render + audit`。** `FAIL` 不许交付。`WARN` 要逐条给出
   "改"或"这是设计内的，因为…"。不许跳过 `verify` 直接渲整片——多花 8 秒只换来一个
   笨不知原因的"画面没动"。
5. **交付三件套**：成片（mp4/webm/gif）+ 接触表（-sheet.png）+ audit 结论。
6. **审美拿不准就给候选，别猜。** 两个配色、两种节奏，让用户选，比交付一个平庸版本强。
7. **不许等素材，自己画。** 交付物里不许出现「建议插入图片」「此处放图」「等素材到位后」。
   渲染管线只有 HTML/CSS/SVG/Canvas——**所有视觉元素只能由代码产生**。
   需要光效/纹理/图形/图标时先查 [references/asset-recipes.md](references/asset-recipes.md)
   （20 类现成片段，可直接粘贴：光晕、扫光、颗粒、玻璃卡、霓虹、网格、抽象插画、粒子、
   线框球、图表、城市剪影、故障风、扫描线、图标集、光束、景深、布纹、散景、伪 3D），
   没有再自己写 SVG path。**禁止用 emoji 或 unicode 符号充当图形。**
   每个画面至少三层（背景渐变/网格 → 主体 → 氛围颗粒/散景），至少 2 个自建视觉元素、
   1 处深度线索（阴影/渐变/叠色/颗粒）。只有一层、只有文字和色块的画面 = 不合格。
8. **既有资产优先，禁止重建。** 工作空间里如果有**已经拼好的骨骼/规范/组件/设计稿**，
   必须**整套沿用**，一个数值都不许重估。用 `rigcheck.mjs --ref` 证明你用的是原值。
   事故记录：某次重建把 `head.pos` 从 `[-6.8,-182.5]` 改成 `[0,-248]`（偏 65.9px）、
   `torso.pv` 从 `[160,160]` 改成 `[160,291]`（偏 131px），效果是**头飘在身体左侧**，
   而"看图检查"没看出来——因为人眼会把它读成"一个角色"。**这类错必须用数字查。**
9. **素材白名单。** 只用 `storyboard.md` 里明确列出的素材。工作空间里别的文件
   （上一版产物、无关角色的图、别的项目的配置）**一律不许碰**，哪怕它看起来能用。
   需要新素材时在 storyboard 里加一行并说明用途，再找。
10. **验收不放水，也不许并发渲染。**
    `audit` 报 WARN 不等于"可以交"：**硬跳变（jump）与纯色帧（flat）必须清零或逐条解释**，
    否则重做。`verify`/`rigcheck` 有 FAIL 一律不许继续。
    渲染**一次只跑一个 `render.mjs` 进程**——脚本带单实例锁，并发只会互相抢 CPU。
    要并行就在一个 Chrome 里开多 tab（见 [cinema-grade.md](references/cinema-grade.md) §9），不是起多个进程。

---

## 数字归工具，判断归你

这一类模型（Flash / mini / turbo）有个共同倾向：**宁愿自己估，也不肯调工具**。
它觉得心算零成本、工具要等。这个成本账是错的，先用数字把它算清楚：

| | 心算 | 调 `ease.mjs` |
| --- | --- | --- |
| 直接耗时 | 0 秒 | 约 0.3–0.5 秒 |
| 一次算对的概率 | 三四十（贝塞尔控制点猜错一位，整条曲线性质就变了） | 100 |
| 错了的代价 | 渲 90 帧 ≈ 8 秒 + 审图，而且**很可能看不出错**，只是"就是不够丝滑" | 0 |
| 期望成本 | 0 + 0.5 × (8 + 30) ≈ **19 秒**，且质量静默下降 | **0.5 秒** |

心算省下的 0.5 秒，是最贵的那种省法。所以这里是硬要求，不是建议：

**下列数字一律来自工具输出，不许在回答里手写推断值：**

| 要什么 | 跑什么 |
| --- | --- |
| 任意贝塞尔的性质（过冲、平台、采样表） | `node scripts/ease.mjs cubic 0.22 1 0.36 1` |
| 弹簧参数（回弹多少、多久停、会不会中途停） | `node scripts/ease.mjs spring 120 14 1 1.2` |
| 把曲线压成 CSS `linear()` | `node scripts/ease.mjs css-linear --preset silkIn` |
| 一组元素的错开步长、会不会超出总时长 | `node scripts/ease.mjs stagger 7 2.4 0.5` |
| 文字对比度是否达标 | `node scripts/ease.mjs contrast "#0b0e14" "#6d8bbd"` |
| 由底色生成可读灰阶 | `node scripts/ease.mjs ramp "#0b0e14" 5` |

**自检三问**（交付前问自己，答不上就是违规）：

1. 我回答里的每个曲线参数，能指向上一条命令的输出吗？
2. 我有没有在哪一行写下了"大概 0.3 左右"这种估出来的数？有 → 删掉，跑命令。
3. 我说"这条曲线很丝滑"，是因为我看了 `ease.mjs` 打的 ASCII 图和过冲百分比，还是因为我猜？

**它也想自己验，那就用验算器让它放心**：`verify.mjs` 读的是真实计算样式，
不是推测。它想"确认一下"的时候，正确动作是跑 `verify`，不是在自己脑子里模拟一遍。

---

## 环境

零 npm 依赖。需要 Chrome 或 Edge（本机已有）+ ffmpeg。

```bash
node scripts/render.mjs --check      # 打印 chrome / ffmpeg / node / WebSocket 能力
```

输出里 `chrome` 是 `NOT FOUND` 时，用 `--chrome <path>` 指定，或先装一个浏览器。

### 没有图像理解时怎么办

有些模型（例如纯文本推理版本）不能 `read_image`。这套链路的判定**全部是数字，不是图片**，
所以仍然能走完：`ease`（参数）→ `verify`（数值轨迹 + 幂等）→ `audit`（像素统计，结论就是数字）
→ `rigcheck`（几何断言）。

- 能做：结构、运动、几何、可读性
- **做不到：构图好坏、配色协调、风格统一、视觉穿模**

后者必须交给能看图的人或视觉模型。但可以**推迟到最后**：先用数字把能抓的错全抓掉，
再一次性给人看 6–8 帧（`--still` 批量抽 + `--guides` 叠加安全区）。

---

## 文档索引（按需读，别一次全读）

| 文件 | 什么时候读 |
| --- | --- |
| [references/wish-mode.md](references/wish-mode.md) | **用户只给一句话时先读这个**：四槽位、章节推导、默认值表、许愿模式下不许做访谈 |
| [references/spec-and-prompt.md](references/spec-and-prompt.md) | STEP 1 写规格表时；要可复制的 prompt 模板时；对付"不愿调工具"的模型时 |
| [references/code-patterns.md](references/code-patterns.md) | STEP 2 写代码时：`seek(t)` 范式、缓动库、`keys()` 关键帧表、`spring(f,z)`、SVG/Canvas、20 种现代 CSS 效果 |
| [references/asset-recipes.md](references/asset-recipes.md) | **画面缺东西时第一时间翻**：光晕、扫光、颗粒、玻璃、霓虹、网格、插画、粒子、线框球、图表、图标集、散景、伪 3D |
| [references/rig-characters.md](references/rig-characters.md) | 画面里有角色要动：部件 + 父子变换链 + pose 表 + 12 条原则怎么落到字段上 |
| [references/cinema-grade.md](references/cinema-grade.md) | 定稿前：运动模糊、编码参数（抗色带）、暗角、HUD 系统、甩镜、帧率选择、长片组织、并行提速 |
| [references/review-checklist.md](references/review-checklist.md) | STEP 5 人眼抽检 + 交付前逐条过 |
| [references/failure-modes.md](references/failure-modes.md) | audit/verify 报错时对号入座 |
| [references/delta-vs-opus.md](references/delta-vs-opus.md) | 想知道"这套东西到底能补到哪一步"、要判断该不该换模型时 |

---

## 先分流：许愿，还是下需求

| 输入长什么样 | 走哪条路 |
| --- | --- |
| 给了尺寸/时长/内容/风格中的多数；或在回答你的追问 | **规格模式**：STEP 0 问清楚 → STEP 1 规格表 → … |
| 一句话 + 授权语气（"做个厉害的""展示你的能力""就像某类片子那样""全力以赴"） | **许愿模式**：跳过 STEP 0，不许反问。先扫工作空间找母题，自己填四个槽位，然后从 STEP 1 起走。见 [wish-mode.md](references/wish-mode.md) |

判据很简单：**他没说清楚的，是"等我问"还是"你定"？** 语气里带"你看着办/全力以赴/展示给我看"就是后者。
许愿模式同样要写 `storyboard.md` —— 区别只是那张表由你写，不是问来的。

## 工作流

### STEP 0 · 问清楚三件事（**仅规格模式**；许愿模式跳过）

- **用途**：投屏片头 / 社交短视频 / 网页 hero 动效 / 讲解插片 / 数据增长动效 / GIF
- **尺寸与时长**：见下表默认值，除非用户明确要求
- **情绪**：稳（企业/金融）、快（科技/发布）、柔（生活/品牌）、硬（游戏/运动）

| 用途 | 尺寸 | 时长 | 帧率 | 格式 |
| --- | --- | --- | --- | --- |
| 片头 / 发布会 | 1920x1080 | 3–6s | 30 | mp4 |
| 社交竖屏 | 1080x1920 | 5–15s | 30 | mp4 |
| 网页 hero / banner | 1920x800 或 1440x600 | 2–4s，可循环 | 30 | webm（带 alpha 更佳） |
| 数据动效 / 图表 | 1920x1080 | 3–8s | 30 | mp4 |
| 循环动图 | 800x800 / 1080x1080 | 1–3s，必须能无缝循环 | 15–20 | gif / webp |
| 讲解插片 | 1920x1080 | 每镜 2–5s，整片再拼 | 30 | mp4 |

超过 **10 秒**或超过 **3 个镜头**：拆成多个场景文件，每个单独渲染单独验收，再用 ffmpeg 拼接。
不要让一个 `seek()` 管 30 秒——那样不会有人能自查。

### STEP 1 · 写规格（唯一允许的自由发挥环节）

产出 `storyboard.md`，两样东西缺一不可：

**① 镜头表**

| # | 时间 | 画面在做什么 | 主要运动 | 收尾状态 |
| --- | --- | --- | --- | --- |
| 1 | 0.00–1.10s | 标题逐字上浮 | y: +96→0, 每字错开 75ms | 标题就位 |
| 2 | 1.10–2.40s | 进度线铺满 + 三点弹出 | scaleX: 0→1（缓入缓出） | 线到边、点齐 |

**② 元素时间轴表**（每个元素一行，这是后面代码的唯一依据）

| 元素 | enter | active | exit | 属性 | 曲线 |
| --- | --- | --- | --- | --- | --- |
| #title span | 0.15 + i*0.075 | 到片尾 | — | translateY 96→0, opacity 0→1 | easeOutCubic |
| #bar b | 0.30 | 0.30–2.40 | — | scaleX 0→1 | easeInOutCubic |
| .dots i | 1.50 + i*0.15 | 到片尾 | — | scale 0→1 | easeOutBack |

写不出这张表 = 你还没想清楚。不要跳过它去写代码，写出来一定是"只有首末帧"。

**「曲线」这一列不是让你写个名字就完事。** 定了名字之后立刻跑一次工具，把"这条曲线
在你这个时长下会怎样"钉死，然后把这行补成带数值的形式：

```bash
node scripts/ease.mjs cubic 0.33 1 0.68 1     # easeOutCubic → 看平台段/过冲
node scripts/ease.mjs stagger 6 2.4 0.7       # 6 个标题字在 2.4s 内、每个 0.7s → 步长与溢出
```

于是表格里那两行变成：

| 元素 | enter | active | exit | 属性 | 曲线（工具确认） |
| --- | --- | --- | --- | --- | --- |
| #title span | 0.15 + i*0.075 | 到片尾 | — | translateY 96→0, opacity 0→1 | cubic-bezier(0.33,1,0.68,1)，过冲 0%，0.75 后有平台段 → 时长压到 0.7s 内 |
| .dots i | 1.50 + i*0.15 | 到片尾 | — | scale 0→1 | spring(120,14) 过冲 7.1%，0.67s 稳定 → 段长给 0.75s |

好曲线的判据（工具会直接告诉你）：**过冲 ≤ 15%**、**没有中段平台**、**弹簧的稳定时间
不超过段长**。任何一条不满足，换参数再跑一次，而不是"先这么写，渲出来看看"。

模板与更多范式： [references/spec-and-prompt.md](references/spec-and-prompt.md)

### STEP 2 · 实现

从骨架开始，不要一次写完整个场景。骨架 = 背景 + 一个元素能动 + `seek` 契约通。

```js
window.scene = {
  duration: 3.0, fps: 30, width: 1920, height: 1080, ready: true,
  seek(t) {
    // 每个元素：把「时间轴表里那一行」逐字翻译成 3 行代码
    // k = 曲线(seg(t, enter, enter + 持续)) → 用 k 插值属性
  },
};
```

必须**内联** CSS 和 JS。不要引外部 CDN（渲染时会断网般失败），
字体用系统字体（`"Segoe UI", "Microsoft YaHei", Arial`）。

可用范式（DOM/CSS/SVG/Canvas/GSAP/Web Animations、缓动库、多段编排、文字逐字、
路径描边、数字滚动、遮罩转场、CSS `linear()`、`filter`/`blend-mode`/`mask` 用法）：
[references/code-patterns.md](references/code-patterns.md)

需要画东西的时候（光效、纹理、图形、图标、图表、插画、伪 3D），**先翻**
[references/asset-recipes.md](references/asset-recipes.md)。那里有 20 类零依赖片段，
都能直接粘进单文件 HTML 并接受 `seek(t)` 驱动。不要凭感觉从零造，也不要等素材。

### STEP 3 · 数值验算（先查数字，别急着渲）

这一步是"多验算"里最先跑的一环：秒级、不用编码、还能点名到元素。

```bash
# 看每个元素的实际轨迹：谁在动、动到哪、哪儿卡住了
node scripts/verify.mjs --html scene.html --select "#bar b,#title span" --props transform,opacity --steps 31

# 验证"画面只由 t 决定"（同一 t 两次调用必须一模一样）
node scripts/verify.mjs --html scene.html --select ".item" --idempotent
```

它会直接告诉你这一类的答案：

- `⚠ #b[0] · sx — 中途停顿 0–2s 之后又继续变化` → 这一段插值被拆断或漏了
- `ℹ #card[0] · (全部) — 这个元素整段没有任何变化` → 选择器没命中 / style 没写进 DOM
- `✖ seek 不幂等：13 处同一 t 两次调用结果不同` → seek 里用了累计状态

数值层过了再往下。**不要在数值有问题的时候就渲整片**——那只会得到一个模糊的
"画面好像没动"，然后你要从像素倒推原因。先让数字说话。

### STEP 4 · 渲染 + 像素验收

先只出关键帧，快、够判断构图对不对：

```bash
node scripts/render.mjs --html scene.html --still 0.2,1.0,2.2 --out out/stills
```

看这几张图（用 read_image 自己看，别跳）。构图 OK 再出整片：

```bash
node scripts/render.mjs --html scene.html --out out/v.mp4 --fps 30 --sheet
node scripts/audit.mjs --video out/v.mp4 --fps 30 --duration 3 --width 1920 --height 1080
```

`audit` 会给你：变化像素曲线、节奏条、以及分级结论。按结论改，**一次只改被点名的那一处**，
改完立刻重跑 audit。最多 5 轮；第 5 轮还 FAIL 就回到 STEP 1 改规格（说明规格本身错了）。

常见报错对号入座： [references/failure-modes.md](references/failure-modes.md)

### STEP 5 · 人眼抽检

机器只保证"结构对"。这几条要你自己看图：

- 文字有没有溢出画面 / 被裁切 / 和背景撞色
- 视觉重心在不在预期位置（三分法 / 居中 / 元素群的重心）
- 对比度够不够（暗背景上 40% 透明度的灰字等于看不见）
- 出入口是否干净（有没有元素在画面外就开始动、在画面内突然消失）

清单： [references/review-checklist.md](references/review-checklist.md)

### STEP 6 · 交付

```bash
# 需要的格式再补一条
node scripts/render.mjs --html scene.html --out out/v.webm --format webm
node scripts/render.mjs --html scene.html --out out/v.gif --format gif --fps 15
```

交付时给：成片路径、接触表、audit 的 verdict 那几行、storyboard.md。
如果 audit 有 WARN 但你判断是设计内的，明说是哪一条、为什么。

**定稿版必须开运动模糊重渲一次。**

```bash
node scripts/render.mjs --html scene.html --out out/final.mp4 --fps 30 --motion-blur 180
```

这是"看起来顺"与"看起来像录屏"的分界。迭代阶段可以临时关着省时间，
但**交付版不许没有快门**——省这个就是在降质。开完重跑一次 audit 确认时长帧数没被改变。
有快速运动（角色动作、甩镜、粒子）时，同时上 `--fps 60`。

---

## 命令速查

```bash
# 体检
node scripts/render.mjs --check

# 算数（曲线 / 弹簧 / 错开 / 对比度）—— 这些不许心算
node scripts/ease.mjs cubic 0.22 1 0.36 1
node scripts/ease.mjs spring 120 14 1 1.2
node scripts/ease.mjs css-linear --preset silkIn
node scripts/ease.mjs stagger 7 2.4 0.5
node scripts/ease.mjs contrast "#0b0e14" "#6d8bbd"
node scripts/ease.mjs ramp "#0b0e14" 5
node scripts/ease.mjs presets

# 骨骼几何体检（有角色时必跑；有现成 rig 时必须 --ref 对齐）
node scripts/rigcheck.mjs --rig rig/ander.rig.json
node scripts/rigcheck.mjs --rig lib/rig.json --ref rig/ander.rig.json
node scripts/rigcheck.mjs --rig rig.json --pose '{"head":{"rot":0.2}}' --assert

# SKILL.md frontmatter 体检（改完 skill 就跑一次，防"整个 skill 加载不了"）
node scripts/lint-skill.mjs

# 数值验算（秒级，能点名元素）
node scripts/verify.mjs --html scene.html --select "#bar b" --props transform,opacity --steps 31
node scripts/verify.mjs --html scene.html --select ".item" --idempotent
node scripts/verify.mjs --html scene.html --all --json

# 关键帧（审图用，最快）
node scripts/render.mjs --html scene.html --still 0,0.5,1.5,2.9 --out out/stills

# 关键帧 + 构图辅助线（100px 网格 / 80px 安全区 / 三分线 / 中心十字）
node scripts/render.mjs --html scene.html --still 1.6 --guides --out out/guides

# 整片 + 接触表
node scripts/render.mjs --html scene.html --out out/v.mp4 --fps 30 --sheet

# 最终交付版开运动模糊（180° 快门 = 电影标准；渲染 ×4，只在定稿时用）
node scripts/render.mjs --html scene.html --out out/final.mp4 --fps 30 --motion-blur 180

# 有快速运动（角色动作、甩镜、粒子）才上 60fps
node scripts/render.mjs --html scene.html --out out/final.mp4 --fps 60 --motion-blur 180

# 2x 超采样（更锐，慢 3–4 倍）
node scripts/render.mjs --html scene.html --out out/v.mp4 --scale 2

# 透明背景（webm / png 序列）
node scripts/render.mjs --html scene.html --out out/v.webm --format webm --alpha

# 循环动图
node scripts/render.mjs --html scene.html --out out/v.gif --format gif --fps 15

# 像素验收
node scripts/audit.mjs --video out/v.mp4 --fps 30 --duration 3 --width 1920 --height 1080
node scripts/audit.mjs --video out/v.gif --loop           # 循环接缝检查
node scripts/audit.mjs --video out/v.mp4 --json out/audit.json
```

`render.mjs` 参数：`--html --out --fps --duration --width --height --scale --format --still --sheet --alpha --file --keep-frames --chrome --check --quiet`
`verify.mjs` 参数：`--html --select --props --from --to --steps --idempotent --all --json --file --chrome`
`audit.mjs` 参数：`--video --fps --duration --width --height --grid --loop --pixel-thresh --json --quiet`

**顺序不要颠倒**：`ease`（算参数）→ `verify`（查数字）→ `render`（出图）→ `audit`（查像素）→ 人眼。
越靠前的错越便宜，越靠后越贵。用便宜的手段堵住能堵的问题。

---

## 多镜头拼接

每个镜头独立成文件、独立验收，全绿后：

```bash
# 直接拼（同分辨率同帧率同编码）
printf "file 's1.mp4'\nfile 's2.mp4'\n" > list.txt
ffmpeg -y -f concat -safe 0 -i list.txt -c copy out/full.mp4

# 要转场就别用 concat：用 xfade
ffmpeg -y -i s1.mp4 -i s2.mp4 -filter_complex \
  "[0:v][1:v]xfade=transition=fade:duration=0.4:offset=2.6[v]" -map "[v]" out/full.mp4
```

拼完对整片再跑一次 `audit`（能抓到镜头之间的黑帧和时长错位）。

---

## 什么时候不该用这个 skill

直说，省得走弯路：

- **要 AI 生成的实拍感画面**（人物、风景、真实运镜）→ 用文生视频模型/相应插件，这不是代码能画的
- **要剪真人素材、录屏、采访** → ffmpeg 剪辑工作流，不需要写动画
- **要配乐、配音、音效** → 另找音频工具；本 skill 只出画面
- **要 3D、物理拟真** → 用 Blender/引擎；HTML/Canvas 做不了可信的物理
- **要一次成片、不容返工、审美即产品** → 这是本 skill 能靠近但补不平的部分，见 delta-vs-opus.md
