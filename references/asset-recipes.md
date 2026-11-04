# 无素材素材库：没有元素，就自己画

强模型和弱模型在这里的区别不是"会不会写 SVG"——都会。是**敢不敢在没有任何现成素材时，
自己把画面填满**。

弱模型的典型退缩动作，全是这一种：

- 「这里建议插入一张图片」→ 把活推回给用户
- 用 emoji 或 unicode 字符凑图形（`★` `▲` `●`）→ 一眼廉价，且跨平台渲染不一致
- 画一个纯色矩形代表"图形"→ 画面贫瘠
- 只做文字 + 背景，回避一切构造 → 99% 的失败产物长这样
- 用一行 `<!-- 装饰 -->` 占位，什么都不画

**规则**：本 skill 的产出里不许出现"建议插入图片""等素材""占位"。渲染管线只有
HTML/CSS/SVG/Canvas——**所有视觉元素只能由代码产生**。下面就是弹药，
复制、改数值、拼起来用。每个片段都是单文件自包含、零外部依赖、可被 `seek(t)` 驱动。

用的时候：**先查这里，没有再写 SVG**。不要凭感觉造轮子。

---

## 1. 聚光 / 光晕（最便宜的"有光源"感）

```html
<div style="position:absolute;inset:0;
  background:radial-gradient(52% 44% at 50% 32%, #24365e 0%, #131a2b 45%, #0a0d15 100%)"></div>
<!-- 主光斑：可动 -->
<div id="glow" style="position:absolute;left:50%;top:32%;width:1400px;height:900px;
  margin-left:-700px;margin-top:-450px;border-radius:50%;
  background:radial-gradient(closest-side, rgba(96,150,255,.30), transparent 72%);
  mix-blend-mode:screen;filter:blur(40px)"></div>
```
```js
glow.style.transform = `translate(${lerp(-60,60,k)}px,${lerp(-20,20,k)}px) scale(${lerp(.9,1.1,k)})`;
```
一个径向渐变 + `mix-blend-mode:screen`，就能让纯黑背景"有空气感"。

## 2. 扫光（"贵"的最便宜来源）

```html
<div id="sheen" style="position:absolute;top:-20%;left:0;width:45%;height:140%;
  transform:skewX(-18deg);
  background:linear-gradient(90deg,transparent,rgba(255,255,255,.16) 45%,rgba(255,255,255,.32) 50%,rgba(255,255,255,.16) 55%,transparent);
  mix-blend-mode:screen"></div>
```
```js
sheen.style.transform = `translateX(${lerp(-600, 2400, k)}px) skewX(-18deg)`;
```
压在任何文字/图形上，瞬时间高级。一次扫过 0.6–1.0s 最好，慢扫显得假。

## 3. 胶片颗粒 / 噪点（去掉"数字味"）

用 SVG `feTurbulence` 内联成 data-uri 背景（比每帧算滤镜快得多）：

```css
.grain {
  position: absolute; inset: 0; pointer-events: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)' opacity='0.5'/%3E%3C/svg%3E");
  opacity: .07; mix-blend-mode: overlay;
}
```
要"动起来的颗粒"：把 `background-position` 按帧换（用 `t` 的整数帧号，保证幂等）：

```js
grain.style.backgroundPosition = `${(Math.floor(t * 30) * 37) % 160}px ${(Math.floor(t * 30) * 71) % 160}px`;
```

## 4. 玻璃卡（拟态，不需要真毛玻璃素材）

```html
<div id="card" style="position:absolute;left:50%;top:40%;width:760px;height:340px;
  margin:-170px 0 0 -380px;border-radius:26px;
  background:linear-gradient(160deg,rgba(255,255,255,.10),rgba(255,255,255,.03));
  border:1px solid rgba(255,255,255,.16);
  box-shadow:0 30px 80px -20px rgba(0,0,0,.7), inset 0 1px 0 rgba(255,255,255,.22);
  backdrop-filter:blur(16px) saturate(140%)"></div>
```
```js
card.style.transform = `translateY(${lerp(40,0,k)}px) scale(${lerp(.96,1,k)})`;
card.style.opacity = k;
```
`inset 0 1px 0 rgba(255,255,255,.22)` 这条内高光是"玻璃"的灵魂，别省。

## 5. 霓虹 / 发光文字

```js
title.style.textShadow = [
  `0 0 ${4 + 10*k}px rgba(110,231,255,.9)`,
  `0 0 ${20 + 60*k}px rgba(79,125,255,.55)`,
  `0 0 ${60 + 120*k}px rgba(79,125,255,.28)`,
].join(',');
```
三层就够。层层同色系、扩散半径递增，是霓虹与"脏阴影"的分界。

## 6. 网格背景 + 渐隐（科技感骨架）

```css
.grid {
  position:absolute; inset:0;
  background-image:
    linear-gradient(rgba(120,170,255,.07) 1px, transparent 1px),
    linear-gradient(90deg, rgba(120,170,255,.07) 1px, transparent 1px);
  background-size: 80px 80px;
  mask-image: radial-gradient(62% 52% at 50% 45%, #000 20%, transparent 78%);
  -webkit-mask-image: radial-gradient(62% 52% at 50% 45%, #000 20%, transparent 78%);
}
```
```js
// 网格缓慢漂移 = 有"空间在动"的感觉，且几乎零成本
grid.style.backgroundPosition = `${(t*8).toFixed(2)}px ${(t*4).toFixed(2)}px`;
```
`mask-image` 让网格向边缘淡出，避免"Excel 表格"感。

## 7. 抽象插画：山峦 / 波形 / 层叠曲线

不需要图，几条 `path` 就是风景：

```html
<svg width="1920" height="1080" style="position:absolute;inset:0">
  <defs>
    <linearGradient id="m1" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1b2a4a"/><stop offset="1" stop-color="#0b0e14"/>
    </linearGradient>
  </defs>
  <path d="M0,760 C240,700 420,820 700,770 C980,720 1180,800 1420,750 C1660,700 1800,780 1920,740 L1920,1080 L0,1080 Z" fill="url(#m1)"/>
  <path d="M0,850 C300,800 520,900 820,860 C1120,820 1400,900 1920,840 L1920,1080 L0,1080 Z" fill="#0e1420" opacity=".9"/>
</svg>
```
层数越多、颜色越接近背景，就越有"远山"的景深。**三层起步。**
波形同理，把 `C` 换成 `Q` 或正弦采样点阵即可。

## 8. 粒子 / 星空（确定性）

```js
const hash = (i) => { const x = Math.sin(i * 127.1) * 43758.5453; return x - Math.floor(x); };
for (let i = 0; i < 260; i++) {
  const x = hash(i) * 1920, y0 = hash(i + 999) * 1080;
  const y = (y0 - t * (12 + hash(i + 31) * 30) + 1080) % 1080;
  const r = 0.6 + hash(i + 7) * 1.8;
  const a = 0.25 + hash(i + 13) * 0.6;
  ctx.fillStyle = `rgba(200,225,255,${a})`;
  ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.fill();
}
```
用 `hash(i)` 而不是 `Math.random()`：粒子位置固定，只有 `y` 随 `t` 移动。audit 不会报闪烁。

## 9. 线框地球 / 球体

```html
<svg width="600" height="600" viewBox="0 0 600 600">
  <g stroke="rgba(110,231,255,.35)" fill="none" stroke-width="1.2" id="globe">
    <circle cx="300" cy="300" r="240"/>
    <ellipse cx="300" cy="300" rx="240" ry="80"/>
    <ellipse cx="300" cy="300" rx="240" ry="160"/>
    <ellipse cx="300" cy="300" rx="80" ry="240"/>
    <ellipse cx="300" cy="300" rx="160" ry="240"/>
  </g>
</svg>
```
```js
globe.style.transform = `rotate(${t * 22}deg)`;
```
经线椭圆旋转，就是"球在转"的错觉。加一条 `radial-gradient` 球面高光更像。

## 10. 进度环 / 仪表盘（conic-gradient，零 SVG）

```js
ring.style.background = `conic-gradient(from -90deg, #6ee7ff ${k * 360}deg, rgba(110,231,255,.10) 0deg)`;
ring.style.borderRadius = '50%';
// 内圈挖空（同心圆遮罩）
```
配一个 `mask: radial-gradient(circle, transparent 58%, #000 60%)` 就是标准环形进度。

## 11. 图表（柱状 / 折线，纯 SVG，数据驱动）

```js
const data = [0.35, 0.62, 0.48, 0.81, 0.57, 0.93];
bars.innerHTML = data.map((v, i) => {
  const h = 420 * v * easeOutCubic(seg(t, 0.3 + i * 0.07, 1.0 + i * 0.07));
  return `<rect x="${140 + i * 110}" y="${760 - h}" width="64" height="${h}" rx="8" fill="url(#barGrad)"/>`;
}).join('');
```
比任何图表库都轻，且完全可控。折线用 `path` 逐点 `L`，再用 `stroke-dashoffset` 做"画出来"。

## 12. 城市剪影

```js
let x = 0, d = 'M0,1080 ';
const hs = [120, 210, 160, 300, 190, 240, 140, 280, 220, 170, 260, 200];
hs.forEach((h, i) => {
  const w = 90 + hash(i) * 70;
  d += `L${x},${1080 - h} L${x},${1080} `;   // 简化：一排梯形楼
  x += w;
  if (x > 1920) return;
});
d += 'L1920,1080 Z';
```
更简单可靠的做法：用 `rect` 阵列 + 随机窗格（`hash` 决定哪些窗亮）。

## 13. 故障风（glitch）

```html
<div class="glitch" data-text="SIGNAL"></div>
<style>
.glitch{position:relative;font:800 140px/1 Arial;color:#eaf1ff}
.glitch::before,.glitch::after{content:attr(data-text);position:absolute;inset:0}
.glitch::before{color:#ff2d6f;mix-blend-mode:screen;text-shadow:-3px 0 #ff2d6f}
.glitch::after{color:#2dffe0;mix-blend-mode:screen;text-shadow:3px 0 #2dffe0}
</style>
```
```js
const j = (Math.floor(t * 30) % 7 === 0) ? 8 : 0;   // 用帧号取模，幂等
glitch.style.transform = `translateX(${j}px)`;
glitch.querySelectorAll('::before');  // 伪元素改不了，改用两个真实 span 承载
```
伪元素不能直接设 style，所以真正做法是两个兄弟 `span`，分别左右偏移。

## 14. 扫描线 / CRT

```css
.scan{position:absolute;inset:0;pointer-events:none;
  background:repeating-linear-gradient(0deg, rgba(0,0,0,.22) 0 1px, transparent 1px 3px);
  mix-blend-mode:multiply}
```
```js
scan.style.transform = `translateY(${(t * 30) % 3}px)`;   // 缓慢下移，模拟刷新
```

## 15. 常用图标（纯 SVG path，直接粘）

```js
const ICONS = {
  play:  'M8 5v14l11-7z',
  pause: 'M6 5h4v14H6zm8 0h4v14h-4z',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  check: 'M20 6L9 17l-5-5',
  lock:  'M6 10V7a6 6 0 1112 0v3M5 10h14v11H5z',
  cloud: 'M6 18a4 4 0 010-8 6 6 0 0111.3-2A4 4 0 1118 18z',
  star:  'M12 3l2.9 6.1 6.6.9-4.8 4.6 1.2 6.6L12 18l-5.9 3.2 1.2-6.6L2.5 10l6.6-.9z',
  pin:   'M12 22s7-6.3 7-12A7 7 0 005 10c0 5.7 7 12 7 12z',
  bolt:  'M13 2L4 14h7l-1 8 9-12h-7z',
  gear:  'M12 15.5A3.5 3.5 0 1112 8.5a3.5 3.5 0 010 7zM19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.9 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.9l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.9.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.9V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z',
  mail:  'M3 6h18v12H3zM3 7l9 6 9-6',
  user:  'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0',
  search:'M10 17a7 7 0 100-14 7 7 0 000 14zM21 21l-5-5',
  download:'M12 3v12M7 10l5 5 5-5M4 21h16',
  chevron:'M9 6l6 6-6 6',
  plus:  'M12 5v14M5 12h14',
  clock: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3.5 2',
  shield:'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  wifi:  'M2 8a16 16 0 0120 0M5 12a11 11 0 0114 0M8.5 15.5a6 6 0 017 0M12 19h.01',
};
const icon = (name, size = 48, color = '#6ee7ff', sw = 2) => `
  <svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"
       stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">
    <path d="${ICONS[name]}"/>
  </svg>`;
```
直接 `el.innerHTML = icon('bolt', 64)`。**别再拿 emoji 当图标。**

## 16. 光束 / 激光

```html
<div id="beam" style="position:absolute;top:-10%;left:46%;width:8px;height:130%;
  transform:rotate(14deg);transform-origin:top center;
  background:linear-gradient(180deg, rgba(110,231,255,.85), rgba(110,231,255,0) 78%);
  filter:blur(2px);mix-blend-mode:screen"></div>
```
再叠一条 `blur(18px)`、宽度 40px、透明度 .35 的同位元素，就是"光柱"。

## 17. 景深 / 多层阴影（让平面有前后）

```js
el.style.boxShadow = `
  0 ${2 + 4*k}px ${6 + 10*k}px rgba(0,0,0,.35),
  0 ${18 + 30*k}px ${40 + 70*k}px rgba(0,0,0,.45),
  0 0 ${80 * k}px rgba(80,140,255,.25)`;
```
**三层**：近景紧影 + 远景散影 + 环境色溢出。一层阴影永远平。

## 18. 纸张 / 布纹

```css
.paper{background:
  repeating-linear-gradient(90deg, rgba(255,255,255,.025) 0 1px, transparent 1px 4px),
  repeating-linear-gradient(0deg, rgba(255,255,255,.02) 0 1px, transparent 1px 5px),
  #12151c}
```

## 19. Bokeh 光斑（虚化散景）

```js
const bokeh = Array.from({length: 9}, (_, i) => {
  const x = hash(i) * 1920, y = hash(i + 50) * 700, r = 40 + hash(i + 90) * 120;
  return `<div style="position:absolute;left:${x - r}px;top:${y - r}px;width:${r*2}px;height:${r*2}px;
    border-radius:50%;mix-blend-mode:screen;filter:blur(${r * .35}px);
    background:radial-gradient(circle, rgba(110,231,255,${.10 + hash(i+3)*.18}), transparent 70%)"></div>`;
}).join('');
```
散景是"氛围"最快的手段：一层 bokeh 压底，任何画面立刻有摄影感。

## 20. 伪 3D 卡片（perspective，不需要 WebGL）

```js
card.style.transform = `perspective(1200px) rotateY(${lerp(-22, 8, k)}deg) rotateX(${lerp(8, -4, k)}deg) translateZ(0)`;
```
配 #17 的三层阴影，就有"浮在空间里"的错觉。**永远不要在 1080p 视频里用 WebGL**：
swiftshader 软件渲染会慢到不能接受。

---

## 组装原则（比片段更重要）

1. **一个镜头一个主角效果**：扫光 / 模糊入场 / 揭示转场，选一个。三个全上会脏。
2. **至少三层**：背景（渐变/网格）→ 主体（文字/卡/图）→ 氛围（颗粒/散景/扫光）。
   只有一层 = 平。弱模型的产物几乎都是"一层"。
3. **每层给一个微动的理由**：背景网格漂 8px/s、散景呼吸 2%、主体位移 96→0。
   静的三层仍然像 PPT。
4. **色彩不超过 4 个**：底、主文字、次文字、强调。要第五个就用 `color-mix()` 调出来。
5. **先黑白再上色**：形状和布局在纯白/纯黑下对了，上色才有意义。用 `--still` 分阶段验。

## 自查：这个画面"敢不敢"

交付前问：

- [ ] 画面里有几个元素是**我自己画**的（不是文字、不是纯色块）？< 2 → 补
- [ ] 有没有至少一处**深度线索**（阴影 / 渐变 / 叠色 / 颗粒 / 散景）？没有 → 平
- [ ] 背景是纯色吗？是 → 换成渐变或网格
- [ ] 有没有用 emoji / unicode 符号充当图形？有 → 换 #15 的图标
- [ ] 有没有出现"建议插入图片"？有 → 删掉，用本文件任一节把它画出来
