# 代码范式：`seek(t)` 纯函数动画

所有范式共用一条规矩：**画面状态只由 `t` 决定**。
不读时钟、不用随机、不用 `requestAnimationFrame`、不留跨帧状态。

## 0. 三件套

```js
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const seg = (t, a, b) => clamp01((t - a) / (b - a));   // t 映射成 0..1 段进度
const lerp = (a, b, k) => a + (b - a) * k;             // 插值
```

任何一行时间轴表都能写成：

```js
const k = ease(seg(t, ENTER, ENTER + DUR));
el.style.transform = `translateY(${lerp(FROM, TO, k)}px)`;
```

## 1. 缓动库（够用，不多）

```js
const linear       = (k) => k;
const easeInQuad   = (k) => k * k;
const easeOutQuad  = (k) => 1 - (1 - k) * (1 - k);
const easeInOutQuad= (k) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
const easeOutCubic = (k) => 1 - Math.pow(1 - k, 3);
const easeInOutCubic = (k) => (k < 0.5 ? 4 * k ** 3 : 1 - Math.pow(-2 * k + 2, 3) / 2);
const easeOutQuart = (k) => 1 - Math.pow(1 - k, 4);
const easeOutExpo  = (k) => (k === 1 ? 1 : 1 - Math.pow(2, -10 * k));
const easeInOutExpo= (k) => k === 0 ? 0 : k === 1 ? 1 : k < 0.5
  ? Math.pow(2, 20 * k - 10) / 2 : (2 - Math.pow(2, -20 * k + 10)) / 2;
const easeOutBack  = (k, s = 1.70158) => 1 + (s + 1) * Math.pow(k - 1, 3) + s * Math.pow(k - 1, 2);
const easeOutElastic = (k) => k === 0 ? 0 : k === 1 ? 1
  : Math.pow(2, -10 * k) * Math.sin((k * 10 - 0.75) * (2 * Math.PI / 3)) + 1;

// 阻尼弹簧（比 easeOutBack 自然，适合 UI 弹入）
const spring = (k, { damping = 12, stiffness = 120 } = {}) => {
  if (k <= 0) return 0; if (k >= 1) return 1;
  const w = Math.sqrt(stiffness);
  return 1 - Math.exp(-damping * k / 2) * Math.cos(w * k * 2);
};
```

选曲线：**入场用 out 类**（快起慢停），**退场用 in 类**（慢起快走），
**转场用 in-out**，**弹入用 back/spring**（幅度别超过 1.15，否则廉价）。

## 1.5 关键帧表 + 参数化弹簧：别逐段手写 seg

### `keys()` —— 用一张表描述整条属性曲线

比堆一串 `seg` 好读，而且**每段能各自指定曲线**：

```js
// [[时间, 值], [时间, 值, 本段曲线], ...]
const k = (t, ks) => {
  if (t <= ks[0][0]) return ks[0][1]
  for (let i = 1; i < ks.length; i++) if (t <= ks[i][0]) {
    const [t0, v0] = ks[i - 1], [t1, v1, e] = ks[i]
    return lerp(v0, v1, (e || easeInOutCubic)(seg(t, t0, t1)))
  }
  return ks[ks.length - 1][1]
}

// 用法：一次写完"起 → 顶 → 落 → 回弹"
const y = k(t, [[0.85, 0], [1.05, -140, easeOutQuad], [1.30, 0, easeInQuad], [1.70, 0]])
```

好处：
- 时间点集中在一行，改节奏只改这一处
- 每条属性一张表，元素的时间轴表可以直接翻译成代码
- 不会出现"某一段忘了写 → 画面卡住"（表是连续的，中间自动插值）

### `spring(dt, f, z)` —— 用"频率 + 阻尼比"代替 stiffness/damping

```js
const spring = (dt, f = 3, z = 0.35) => {
  if (dt <= 0) return 0
  const w = 2 * Math.PI * f, wd = w * Math.sqrt(1 - z * z)
  return 1 - Math.exp(-z * w * dt) * (Math.cos(wd * dt) + (z * w / wd) * Math.sin(wd * dt))
}
const ring = (dt, f = 3, decay = 6) => dt < 0 ? 0 : Math.exp(-decay * dt) * Math.cos(2 * Math.PI * f * dt)
```

- `f`：每秒振荡次数。2–4 软弹，6+ 硬弹
- `z`：阻尼比。0.2 强回弹 / 0.35 自然 / 0.7 几乎不回弹
- `dt`：距动作开始的**秒数**（不是 0..1 的进度），所以不用担心时长缩放
- `ring()` 给跟随件（发梢、尾巴、光效衰减）：从 1 开始振荡衰减

这两种写法比 `easeOutBack` 好在：**回弹次数和衰减速度是两个独立可调的旋钮**。
`easeOutBack` 只能调过冲量，调不出"弹两下就停"和"弹一下停"的区别。

### `layout()` —— 逐字排版必须自己量

想让每个字独立做动画，就不能靠 `flex gap`（拿不到精确宽度）：

```js
const layout = (g, str, font, spacing = 0) => {
  g.font = font; g.letterSpacing = spacing + 'px'
  const chars = [...str], xs = []
  let acc = ''
  for (const ch of chars) { xs.push(g.measureText(acc).width); acc += ch }
  const total = g.measureText(str).width
  const ws = chars.map((ch, i) => (i < chars.length - 1 ? xs[i + 1] : total) - xs[i])
  return { chars, xs, ws, total, cap: g.measureText('H').actualBoundingBoxAscent }
}
// 之后就能：第 i 个字画在 x0 + xs[i] + 动画偏移处
```
`cap` 是字高，用来做基线对齐（不同字符的 `actualBoundingBoxAscent` 不同，
用固定行高会出现"有的字偏高"）。

### `typed(str, t, t0, rate)` —— 打字机

```js
const typed = (str, t, t0, rate) => [...str].slice(0, Math.floor(clamp((t - t0) / rate, 0, 1e9))).join('')
```

### 派生时间点必须算，不许手填

一个弹跳的飞行时间不是感觉出来的：

```js
const G = 30000                                   // px/s²，夸张化的"卡通重力"
const flightTime = (h) => 2 * Math.sqrt(2 * h / G) // 起落同一高度的时间
const heights = [300, 150, 60, 20]                 // 逐次衰减
```
手填的 0.1s 偏差在成片里就是"卡了一下"。顶点时刻、落地时刻、错开序列、
扫描线反解——全部由公式算出（反解用二分，20 次迭代够）。

---

## 2. 时间轴编排

### 串行（下一段接着上一段）

```js
const k1 = easeOutCubic(seg(t, 0.0, 0.6));    // 0.0–0.6 进场
const k2 = easeInOutCubic(seg(t, 0.6, 1.8));  // 0.6–1.8 推进
```

### 并行 + 错开（stagger）

```js
const items = [...document.querySelectorAll('.item')];
items.forEach((el, i) => {
  const START = 0.2 + i * 0.08;          // 错开 80ms
  const k = easeOutCubic(seg(t, START, START + 0.5));
  el.style.opacity = k;
  el.style.transform = `translateY(${lerp(24, 0, k)}px)`;
});
```

### 三段式（进 → 停 → 出）

时间轴表必须有这三列，代码也必须有三个区间。**只有 enter 是"中段静止"的头号成因**。

```js
const IN = [0.0, 0.6], OUT = [2.4, 2.9];
const kin  = easeOutCubic(seg(t, IN[0], IN[1]));
const kout = easeInCubic(seg(t, OUT[0], OUT[1]));
const k = kin * (1 - kout);                 // 进完停在 1，出场再乘到 0
el.style.opacity = k;
```

## 3. DOM / CSS 范式

### 逐字入场

```js
titleEl.innerHTML = [...'MOTION'].map((c) => `<span>${c}</span>`).join('');
[...titleEl.querySelectorAll('span')].forEach((el, i) => {
  const k = easeOutCubic(seg(t, 0.15 + i * 0.075, 0.85 + i * 0.075));
  el.style.transform = `translateY(${lerp(96, 0, k)}px)`;
  el.style.opacity = k;
});
```
用 `inline-block` 的 `span`，否则 `translateY` 对行内元素无效。

### 遮罩揭示（比淡入高级，推荐）

```html
<div class="mask"><h1>REVEAL</h1></div>
<style>
.mask { overflow: hidden; }
.mask h1 { transform: translateY(100%); }
</style>
```
```js
h1.style.transform = `translateY(${lerp(100, 0, easeOutCubic(seg(t, 0.2, 0.9)))}%)`;
```

### 进度条 / 缩放（用 transform，不用 width）

```js
bar.style.transform = `scaleX(${easeInOutCubic(seg(t, 0.3, 2.4))})`;
bar.style.transformOrigin = '0 50%';
```
改 `width` 会触发重排，300 帧下来慢且容易抖。

### 用 CSS 变量减少重复 set

```js
root.style.setProperty('--p', easeInOutCubic(seg(t, 0, 2)).toFixed(4));
```
```css
#bar { transform: scaleX(var(--p, 0)); }
```

## 4. SVG 范式

### 描边动画（路径自绘）

```js
const path = document.querySelector('#wave path');
// 页面加载时量一次，之后只改这两个值
const len = path.getTotalLength();
path.style.strokeDasharray = len;
path.style.strokeDashoffset = len * (1 - easeInOutCubic(seg(t, 0.2, 1.6)));
```
`getTotalLength()` 在 `ready` 里读一次并存起来，别在 `seek` 里读（会强制回流）。

### 遮罩转场

```html
<svg><defs><clipPath id="c"><circle id="crc" cx="960" cy="540" r="0"/></clipPath></defs></svg>
<div style="clip-path:url(#c)">第二层内容</div>
```
```js
crc.setAttribute('r', String(lerp(0, 1100, easeInOutCubic(seg(t, 1.0, 2.0)))));
```

## 5. Canvas 范式

Canvas 必须在每次 `seek` 里**完整重画**（清空 → 绘制），不能"在上次基础上继续画"。

```js
const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');

window.scene = {
  duration: 6, fps: 30, width: 1920, height: 1080,
  seek(t) {
    ctx.clearRect(0, 0, 1920, 1080);
    ctx.fillStyle = '#0b0e14';
    ctx.fillRect(0, 0, 1920, 1080);
    const k = easeOutCubic(seg(t, 0, 1));
    ctx.fillStyle = '#6ee7ff';
    ctx.fillRect(200, 540 - 40 * k, 1520 * k, 80);
  },
};
```
设备像素比：canvas 的 `width/height` 属性设成 CSS 尺寸的 2 倍，`ctx.scale(2,2)`，
否则高 DPI 下边缘发糊。

### 确定性伪随机（画粒子/阵列必用）

```js
// 千万别用 Math.random()：每帧值不同 → audit 会报"闪烁"，而且无法复现
const hash = (i) => {
  let x = Math.sin(i * 127.1) * 43758.5453;
  return x - Math.floor(x);           // [0,1)，只由 i 决定，稳定
};
for (let i = 0; i < 200; i++) {
  const x = hash(i) * 1920;
  const y = hash(i + 999) * 1080;
  const s = 0.5 + hash(i + 777) * 2;
  // 用 t 驱动它们，而不是用随机驱动
  const y2 = (y + t * 60 * hash(i + 31)) % 1080;
  ctx.beginPath(); ctx.arc(x, y2, s, 0, Math.PI * 2); ctx.fill();
}
```

## 6. 数字滚动（数据动效最常用）

```js
const n = Math.round(lerp(0, 1284000, easeOutExpo(seg(t, 0.4, 2.0))));
counterEl.textContent = n.toLocaleString('en-US');
```
注意：变化发生在 `Math.round` 之后，单个数字的视觉跳动是正常的，
audit 的 `jump` 检查可能提示——如果是设计内的，明说即可。

## 7. Web Animations / CSS 动画（适配层）

`render.mjs` 在每次 `seek` 后会遍历 `document.getAnimations()`
并设 `currentTime = t*1000` 且 `pause()`。所以下面这种写法**也能被帧精确驱动**：

```js
const a = el.animate([{opacity:0},{opacity:1}], {duration: 600, fill: 'both'});
// 不用自己 seek，render 会接管时间
```
但**不要**给它 `iterations: Infinity` 且依赖内部绘制——无限动画的 `currentTime` 语义容易踩坑。
更稳的是手写 `seek`。GSAP 的话：

```js
const tl = gsap.timeline({paused: true});
tl.to('.box', {x: 400, duration: 1, ease: 'power2.out'});
window.scene = { duration: 2, seek(t) { tl.seek(t); } };   // 交给纯函数
```

## 8. 现代 CSS 效果清单（让画面不像 2010 年的关键）

强模型在这块赢在"想得到"。下面每一条都能直接提升质感，且都能被 `seek(t)` 驱动
（因为是改 `style`，不是跑 keyframes）。按性价比排序：

### 8.1 `filter` —— 最便宜的高级感

```js
el.style.filter = `blur(${lerp(12, 0, k)}px) brightness(${lerp(1.4, 1, k)})`;
```
- 入场用 `blur(12px) → 0` 比淡入高级得多（"从雾里显影"）
- 强调用 `brightness(1) → 1.15 → 1` 做一次呼吸
- ⚠️ 视频渲染的坑：`filter: blur()` **每帧重算**，1080p 大区域模糊会让渲染从 90ms/帧
  变成 400ms/帧。要长时间模糊，就把模糊做在**小元素**上，或用预渲染的 PNG 代替。

### 8.2 `mix-blend-mode` / `background-blend-mode` —— 叠色

```css
.glow { mix-blend-mode: screen; }     /* 光晕叠加，黑底不遮暗 */
.grain { mix-blend-mode: overlay; opacity: .06; }  /* 颗粒质感 */
```
- `screen`：光效、辉光
- `overlay` / `soft-light`：颗粒、纸张、噪点
- `multiply`：阴影、压暗
- ⚠️ 与 `filter` 叠加时渲染更慢；`isolation: isolate` 可以限制混合范围避免全屏重算

### 8.3 `mask` / `clip-path` —— 转场与揭示

```js
// 圆形扩散转场
el.style.clipPath = `circle(${lerp(0, 75, k)}% at 50% 45%)`;
// 斜切揭示
el.style.clipPath = `polygon(0 0, ${lerp(0, 100, k)}% 0, ${lerp(0, 100, k)}% 100%, 0 100%)`;
```
```css
/* 渐变遮罩：文字从边缘淡出，比整段 opacity 高级 */
.fade-mask {
  mask-image: linear-gradient(180deg, #000 60%, transparent 100%);
  -webkit-mask-image: linear-gradient(180deg, #000 60%, transparent 100%);
}
```
`clip-path` 用百分比就与分辨率无关，非常适合同时出 16:9 和 9:16 两个版本。

### 8.4 渐变光效（不用图片就能有"体积感"）

```css
/* 中心光晕 */
background: radial-gradient(60% 50% at 50% 35%, #1b2947 0%, #0b0e14 70%);
/* 扫光（配合 translate 驱动） */
.sheen { background: linear-gradient(100deg, transparent 30%, rgba(255,255,255,.18) 50%, transparent 70%); }
```
```js
sheen.style.transform = `translateX(${lerp(-120, 120, k)}%)`;
```
扫光是"贵"的最便宜来源：一条白色半透明斜带横穿标题，成本几乎为零。

### 8.5 `conic-gradient` —— 进度环 / 角标

```js
ring.style.background = `conic-gradient(#6ee7ff ${lerp(0, 360, k)}deg, rgba(110,231,255,.12) 0deg)`;
```

### 8.6 `backdrop-filter` —— 玻璃拟态

```css
.card { backdrop-filter: blur(18px) saturate(140%); background: rgba(20,28,44,.45); }
```
⚠️ 视频渲染里 `backdrop-filter` 是最贵的属性之一（每帧要取背景再模糊）。
3 秒片可以接受，10 秒片会明显拖慢。

### 8.7 `text-shadow` / `drop-shadow` —— 文字贴住背景

```js
title.style.textShadow = `0 0 ${lerp(0, 60, k)}px rgba(96,150,255,.55)`;
```
发光强度做成动画（0 → 60px），比静态发光有生命感。`filter: drop-shadow()`
对 SVG 图标同理。

### 8.8 `color-mix()` 与 `@property`

```css
--accent: color-mix(in oklab, #4f7dff 60%, #6ee7ff);
@property --angle { syntax: '<angle>'; initial-value: 0deg; inherits: false; }
```
`@property` 让自定义属性可以平滑插值（渐变角度、色相都能动）。
⚠️ 兼容性：Chrome 111+。我们的渲染器就是 Chrome，所以能用；但交付给网页时要注意降级。

### 8.9 SVG 特效（`feTurbulence` 做颗粒/液态）

```html
<filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="3"/></filter>
```
把 `<rect filter="url(#grain)" opacity="0.05">` 铺在最上层 = 胶片颗粒。
⚠️ 每帧重算，慢；静态颗粒建议渲一张 PNG 当背景图。

### 8.10 什么时候**不要**用这些

- 元素数量多 + 每个都带 blur/filter → 渲染时间爆炸
- 一次画面里超过 2 种"高级效果"→ 互相打架，显得脏
- 效果不服务于信息 → 删掉。**克制本身就是高级感**

一条实用原则：**每个镜头只选一个"主角效果"**（要么扫光，要么模糊入场，要么转场揭示），
其余全部朴素。强模型也不是靠堆效果赢的。

---

## 9. 坑清单

| 坑 | 症状 | 修 |
| --- | --- | --- |
| `transform` 加到行内元素 | 没有效果 | 父元素 `display:inline-block` |
| 用 `left/top` 做位移 | 抖动、发虚、audit 报硬跳 | 用 `translate` |
| `transform-origin` 默认 50% 50% | 进度条从中间长 | 设 `0 50%` |
| 字体未加载就测量 | 文字位置跳 | `scene.ready` 里 `await document.fonts.ready` |
| `getTotalLength()` 写在 seek 里 | 每帧强制回流，慢 | 载入时算一次 |
| 半透明叠加没设背景 | mp4 里出现黑边 | `--alpha` + webm，或给底色 |
| 元素超出 1920x1080 | 被裁 | `#stage{overflow:hidden}`，留 80px 安全边 |
| z-index 乱序 | 元素盖住标题 | 按层显式编号，别靠 DOM 顺序 |
| `Date.now()` 做"欢迎动画" | 每次渲的不一样 | 换成 `t` |
