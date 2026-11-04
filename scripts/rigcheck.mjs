#!/usr/bin/env node
/**
 * rigcheck.mjs — 骨骼几何体检（零依赖）
 *
 * 解决一个具体事故：角色的部件错位了 65–131 像素，但"看图检查"没发现，
 * 于是带着断开的头交付了。原因不是眼睛不好，是**这类错误本来就该用数字查，不该用眼睛查**：
 * 人（和模型）看一个角色图时先验是"这是个人形"，会自动忽略 65px 的头身偏移。
 *
 * 它做两件事：
 *   1. 内部一致性：父节点存在、无环、pv 落在画布内、层级 y 顺序、左右对称、z 序
 *   2. 参考对比：--ref 给一份已知正确的 rig（例如美术/上游拼好的），逐部件比较
 *      pos / pv / rot / sc / z，按**素材文件名**对齐，不靠英文命名
 *   3. --assert：给一个 pose，检查变换链是否守恒（父子枢轴距离不变 = 骨长不变）
 *
 * 用法：
 *   node rigcheck.mjs --rig rig/ander.rig.json
 *   node rigcheck.mjs --rig lib/rig.json --ref rig/ander.rig.json        # 抓"擅自重建骨骼"
 *   node rigcheck.mjs --rig rig.json --pose '{"head":{"rot":0.2}}' --assert
 *   node rigcheck.mjs --rig rig.json --json out/rigcheck.json --quiet
 *
 * 支持的 rig 格式（两种都吃）：
 *   { bones: { name: {parent, pos, rot, sc} }, parts: { name: {img, src, pv, parent, pos, rot, sc, z, canvas} } }
 *   { parts: { name: {parent, pos, pv, ...} } }        // bones 内联在 parts 里也能跑
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const opt = { quiet: false }
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  const val = () => { const v = argv[++i]; if (v === undefined) fail(`${a} 缺少取值`); return v }
  switch (a) {
    case '--rig': opt.rig = val(); break
    case '--ref': opt.ref = val(); break
    case '--pose': opt.pose = val(); break
    case '--assert': opt.assert = true; break
    case '--json': opt.json = val(); break
    case '--quiet': opt.quiet = true; break
    case '--tol-pv': opt.tolPv = Number(val()); break
    case '--tol-pos': opt.tolPos = Number(val()); break
    case '-h': case '--help':
      console.log(`用法: node rigcheck.mjs --rig <rig.json> [--ref <ref.json>] [--pose <json>] [--assert] [--json out.json]`)
      console.log(`  --tol-pv  枢轴偏差容差（px，默认 6）`)
      console.log(`  --tol-pos 关节偏移容差（px，默认 6）`)
      process.exit(0)
    default: fail(`未知参数 ${a}`)
  }
}
function fail(m) { console.error('✖ ' + m); process.exit(1) }
if (!opt.rig) fail('缺少 --rig')
if (!existsSync(opt.rig)) fail(`找不到 ${opt.rig}`)
const TOL_PV = opt.tolPv ?? 6
const TOL_POS = opt.tolPos ?? 6

// ------------------------------------------------------------ 装载

async function loadRig(file) {
  const raw = JSON.parse(await readFile(file, 'utf8'))
  const bones = raw.bones || {}
  const parts = raw.parts || {}
  // 统一成节点表：name -> { parent, pos, rot, sc, pv, src, z, canvas, isPart }
  const nodes = {}
  for (const [name, b] of Object.entries(bones)) {
    nodes[name] = {
      name, parent: b.parent ?? null, pos: b.pos || [0, 0],
      rot: b.rot || 0, sc: b.sc ?? 1, pv: null, src: null, z: null,
      canvas: b.canvas, isPart: false,
    }
  }
  for (const [name, p] of Object.entries(parts)) {
    nodes[name] = {
      name, parent: p.parent ?? null, pos: p.pos || [0, 0],
      rot: p.rot || 0, sc: p.sc ?? 1, pv: p.pv || null,
      src: p.src || p.img || p.file || null, z: p.z ?? null,
      canvas: p.canvas, isPart: true,
    }
    // 若 parts 里的 parent 指向一个既不在 bones 也不在 parts 里的名字 → 后面报
  }
  return { raw, nodes, file, feet: raw.feet ?? null, name: raw.name || path.basename(file) }
}

// ------------------------------------------------------------ 2D 矩阵（[a c e; b d f]）

const I = () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
const mul = (m1, m2) => ({
  a: m1.a * m2.a + m1.c * m2.b,
  b: m1.b * m2.a + m1.d * m2.b,
  c: m1.a * m2.c + m1.c * m2.d,
  d: m1.b * m2.c + m1.d * m2.d,
  e: m1.a * m2.e + m1.c * m2.f + m1.e,
  f: m1.b * m2.e + m1.d * m2.f + m1.f,
})
const Tr = (x, y) => ({ a: 1, b: 0, c: 0, d: 1, e: x, f: y })
const Ro = (rad) => ({ a: Math.cos(rad), b: Math.sin(rad), c: -Math.sin(rad), d: Math.cos(rad), e: 0, f: 0 })
const Sc = (sx, sy) => ({ a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 })
const apply = (m, x, y) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f })

// ------------------------------------------------------------ 求解

/** 世界矩阵：world(n) = world(parent) · T(pos) · R(rot) · S(sc)；枢轴 = apply(world(parent), pos) */
function solve(nodes, pose = {}) {
  const w = {}, pivot = {}, visiting = new Set(), bad = []
  const get = (name) => {
    if (w[name]) return w[name]
    const n = nodes[name]
    if (!n) return I()
    if (visiting.has(name)) { bad.push(`循环引用：${[...visiting].join(' → ')} → ${name}`); return I() }
    visiting.add(name)
    const pm = n.parent ? get(n.parent) : I()
    visiting.delete(name)
    const p = pose[name] || {}
    const posX = n.pos[0] + (p.dx || 0)
    const posY = n.pos[1] + (p.dy || 0)
    pivot[name] = apply(pm, posX, posY)
    const m = mul(mul(mul(pm, Tr(posX, posY)), Ro((n.rot || 0) + (p.rot || 0))),
      Sc((n.sc ?? 1) * (p.sx ?? 1), (n.sc ?? 1) * (p.sy ?? 1)))
    return (w[name] = m)
  }
  for (const name of Object.keys(nodes)) get(name)
  return { world: w, pivot, bad }
}

// ------------------------------------------------------------ 检查

const findings = []
const add = (level, kind, msg, hint = '') => findings.push({ level, kind, msg, hint })

const rig = await loadRig(opt.rig)
const { nodes } = rig
const names = Object.keys(nodes)
if (!names.length) fail('rig 里没有机节点（bones / parts 都是空的）')

// 1. 父节点存在 / 无环
const { pivot, bad } = solve(nodes, opt.pose ? JSON.parse(opt.pose) : {})
for (const b of bad) add('fail', 'graph', b, '检查 parent 字段拼写')
for (const n of Object.values(nodes)) {
  if (n.parent && !nodes[n.parent]) {
    add('fail', 'graph', `${n.name} 的 parent "${n.parent}" 不存在`,
      'Opus 那套里部件挂在 chest/head/hip 上；重建时漏掉 bone 节点会造成整片部件丢失')
  }
}

// 2. pv 落在画布内
for (const n of Object.values(nodes)) {
  if (!n.pv || !n.canvas) continue
  const c = n.canvas, half = c / 2
  const [x, y] = n.pv
  if (x < 0 || y < 0 || x > c || y > c) {
    add('fail', 'pv', `${n.name} 的 pv [${x}, ${y}] 超出画布 ${c}×${c}`,
      'pv 是部件自身的像素坐标，必须 0..canvas')
  } else if (Math.abs(x - half) > c * 0.35 || Math.abs(y - half) > c * 0.35) {
    add('warn', 'pv', `${n.name} 的 pv [${x}, ${y}] 远离画布中心 (${half}, ${half})`,
      'Gacha 切图的枢轴一般在画布中心；偏离很远要确认这是有意为之（否则旋转会绕错点）')
  }
}

// 3. 层级 y 顺序（y 向下为正）：head < chest < hip < root
{
  const order = ['head', 'chest', 'hip', 'root']
  const present = order.filter((k) => pivot[k])
  for (let i = 1; i < present.length; i++) {
    const up = present[i - 1], dn = present[i]
    if (pivot[up].y >= pivot[dn].y) {
      add('fail', 'hierarchy', `${up}.y=${pivot[up].y.toFixed(1)} 应当小于 ${dn}.y=${pivot[dn].y.toFixed(1)}（y 轴向下为正）`,
        '头在胸上方、胸在胯上方。反了说明关节偏移的符号或父子关系错了 —— 这就是"头跑到脚下面"或"头飘到旁边"的成因')
    }
  }
  const dxHead = pivot.head && pivot.chest ? Math.abs(pivot.head.x - pivot.chest.x) : 0
  const dyHead = pivot.head && pivot.chest ? Math.abs(pivot.head.y - pivot.chest.y) : 0
  if (pivot.head && pivot.chest && dxHead > dyHead * 0.6) {
    add('warn', 'hierarchy', `头相对胸的横向偏移 ${dxHead.toFixed(1)}px 超过纵向 ${dyHead.toFixed(1)}px 的 60%`,
      '头基本该在胸正上方。横向偏移过大 = 头会飘到肩膀外侧')
  }
}

// 4. 左右对称（按 _L/_R、-左/-右、L/R 结尾配对）
{
  const pairs = []
  for (const n of names) {
    const m = n.match(/^(.*?)(_L|_R|-左|-右|L|R)$/)
    if (!m) continue
    const base = m[1]
    const side = /_L|-左|L$/.test(n) ? 'L' : 'R'
    const other = names.find((o) => o !== n && (o === base + (side === 'L' ? '_R' : '_L')
      || o === base + (side === 'L' ? '-右' : '-左')))
    if (other) pairs.push([n, other])
  }
  const seen = new Set()
  for (const [a, b] of pairs) {
    const key = [a, b].sort().join('|')
    if (seen.has(key)) continue
    seen.add(key)
    const pa = pivot[a], pb = pivot[b]
    if (!pa || !pb) continue
    const sumX = pa.x + pb.x
    const midX = pivot.root ? pivot.root.x : 0
    const off = Math.abs(sumX - 2 * midX)
    const scale = Math.max(1, Math.abs(pa.x - midX) + Math.abs(pb.x - midX))
    // 真实美术的左右本来就不完全对称（参考 rig 里 armA 就差 21px），
    // 所以只在偏差大到"像是放错侧"时才报
    if (off > Math.max(40, scale * 0.35)) {
      add('warn', 'symmetry', `${a} / ${b} 严重不对称（中线 x=${midX.toFixed(1)}，两者和为 ${sumX.toFixed(1)}，偏 ${off.toFixed(1)}px）`,
        '左右部件的 pos.x 应互为相反数。偏 40px 以上通常是把某个部件放到了同一侧，或镜像时漏了负号')
    }
  }
}

// 5. z 序重复（合成一条，别刷屏）
{
  const zs = {}
  for (const n of Object.values(nodes)) {
    if (n.z == null) continue
    ;(zs[n.z] = zs[n.z] || []).push(n.name)
  }
  const dups = Object.entries(zs).filter(([, list]) => list.length > 1)
  if (dups.length) {
    add('info', 'z', `${dups.length} 组部件共用 z 值（${dups.slice(0, 4).map(([z, l]) => `z=${z}:${l.length}个`).join('、')}）`,
      '左右成对件共用 z 是正常的；只在"该盖住的东西被盖住"时才是问题')
  }
}

// 6. 变换链守恒（--assert）：给 pose 时，父子枢轴距离必须不变
if (opt.assert) {
  const pose = opt.pose ? JSON.parse(opt.pose) : {}
  const rest = solve(nodes, {})
  const posed = solve(nodes, pose)
  for (const n of Object.values(nodes)) {
    if (!n.parent) continue
    const ra = rest.pivot[n.name], rb = rest.pivot[n.parent]
    const pa = posed.pivot[n.name], pb = posed.pivot[n.parent]
    if (!ra || !rb || !pa || !pb) continue
    const d0 = Math.hypot(ra.x - rb.x, ra.y - rb.y)
    const d1 = Math.hypot(pa.x - pb.x, pa.y - pb.y)
    if (Math.abs(d1 - d0) > 0.5) {
      add('fail', 'chain', `${n.name} 在 pose 下骨长从 ${d0.toFixed(2)} 变成 ${d1.toFixed(2)}`,
        '刚性骨长的关节链不该变长。变了说明 rot 乘在了错误的层级（应在子节点枢轴之后）')
    }
  }
}

// 7. 参考对比（核心：抓"擅自重建骨骼"）
let refReport = null
if (opt.ref) {
  if (!existsSync(opt.ref)) fail(`找不到参考 rig：${opt.ref}`)
  const ref = await loadRig(opt.ref)
  refReport = []
  // 按素材文件名对齐；没有 src 的退化到节点名
  const keyOf = (r) => {
    const map = new Map()
    for (const n of Object.values(r.nodes)) {
      const k = (n.src || n.name || '').toString().trim()
      if (!map.has(k)) map.set(k, n)
    }
    return map
  }
  const mine = keyOf(rig), theirs = keyOf(ref)
  const onlyMine = [], onlyRef = [], diffs = []

  for (const [k, n] of mine) {
    const r = theirs.get(k)
    if (!r) { onlyMine.push(n.name); continue }
    if (n.pv && r.pv) {
      const dx = n.pv[0] - r.pv[0], dy = n.pv[1] - r.pv[1]
      if (Math.hypot(dx, dy) > TOL_PV) {
        diffs.push({
          kind: 'pv', part: n.name, src: k,
          mine: n.pv, ref: r.pv, delta: [+dx.toFixed(1), +dy.toFixed(1)],
          dist: +Math.hypot(dx, dy).toFixed(1),
        })
      }
    }
    const dx = (n.pos?.[0] ?? 0) - (r.pos?.[0] ?? 0)
    const dy = (n.pos?.[1] ?? 0) - (r.pos?.[1] ?? 0)
    if (Math.hypot(dx, dy) > TOL_POS) {
      diffs.push({
        kind: 'pos', part: n.name, src: k,
        mine: n.pos, ref: r.pos, delta: [+dx.toFixed(1), +dy.toFixed(1)],
        dist: +Math.hypot(dx, dy).toFixed(1),
      })
    }
    if (Math.abs((n.rot || 0) - (r.rot || 0)) > 0.02) {
      diffs.push({ kind: 'rot', part: n.name, src: k, mine: n.rot, ref: r.rot, delta: +(n.rot - r.rot).toFixed(3) })
    }
    if (Math.abs((n.sc ?? 1) - (r.sc ?? 1)) > 0.02) {
      diffs.push({ kind: 'sc', part: n.name, src: k, mine: n.sc, ref: r.sc, delta: +((n.sc ?? 1) - (r.sc ?? 1)).toFixed(3) })
    }
    if (n.z != null && r.z != null && n.z !== r.z) {
      diffs.push({ kind: 'z', part: n.name, src: k, mine: n.z, ref: r.z, delta: n.z - r.z })
    }
  }
  for (const [k, r] of theirs) if (!mine.has(k)) onlyRef.push(r.name)

  const hardDiffs = diffs.filter((d) => d.kind === 'pv' || d.kind === 'pos')
  const worst = hardDiffs.slice().sort((a, b) => (b.dist || 0) - (a.dist || 0))[0]

  if (hardDiffs.length) {
    add('fail', 'ref',
      `与参考骨骼有 ${hardDiffs.length} 处几何偏差（阈值 pv ${TOL_PV}px / pos ${TOL_POS}px）` +
      (worst ? `，最大一处 ${worst.part} 的 ${worst.kind} 偏 ${worst.dist}px` : ''),
      '如果参考骨骼是美术/上游拼好的，就必须整套沿用，不许重估。重估的结果就是头飘在身体旁边 —— '
      + '因为那些 pos 是模板匹配合出来的，不是估出来的')
  }
  if (onlyRef.length) {
    add('warn', 'ref', `参考里有 ${onlyRef.length} 个部件你没实现：${onlyRef.slice(0, 8).join('、')}${onlyRef.length > 8 ? ' …' : ''}`,
      '缺部件会让角色少零件（少头发、少耳机）。逐一确认是有意省略还是漏了')
  }
  if (onlyMine.length) {
    add('info', 'ref', `你多出 ${onlyMine.length} 个参考里没有的部件：${onlyMine.slice(0, 8).join('、')}`,
      '多出来通常是自造部件（例如把骨骼节点当部件），确认不是重复绘制')
  }
  refReport = { ref: path.resolve(opt.ref), matched: mine.size - onlyMine.length, diffs, onlyMine, onlyRef }
}

const fails = findings.filter((f) => f.level === 'fail')
const warns = findings.filter((f) => f.level === 'warn')
const verdict = fails.length ? 'FAIL' : warns.length ? 'WARN' : 'PASS'

const result = {
  verdict, rig: path.resolve(opt.rig), name: rig.name,
  nodes: names.length,
  parts: Object.values(nodes).filter((n) => n.isPart).length,
  feet: rig.feet,
  findings,
  ref: refReport,
}

if (opt.json) {
  await mkdir(path.dirname(path.resolve(opt.json)), { recursive: true })
  await writeFile(path.resolve(opt.json), JSON.stringify(result, null, 2), 'utf8')
}

if (!opt.quiet) {
  const tag = { fail: '✖ FAIL', warn: '⚠ WARN', info: 'ℹ INFO' }
  console.log(`\n骨骼体检 ${path.basename(opt.rig)}  →  ${verdict}\n`)
  console.log(`  节点 ${names.length}（部件 ${result.parts}）  feet=${rig.feet ?? '—'}`)
  if (refReport) {
    console.log(`  参考 ${path.basename(refReport.ref)}：按素材名匹配 ${refReport.matched} 个，几何偏差 ${refReport.diffs.filter((d) => d.dist != null).length} 处`)
  }
  console.log('')
  if (!findings.length) console.log('  没有发现问题。')
  for (const f of findings) {
    console.log(`  ${tag[f.level]}  [${f.kind}] ${f.msg}`)
    if (f.hint) console.log(`         → ${f.hint}`)
  }
  if (refReport && refReport.diffs.length) {
    console.log('\n  偏差明细（按距离排序，前 12 条）：')
    for (const d of refReport.diffs.filter((x) => x.dist != null).sort((a, b) => b.dist - a.dist).slice(0, 12)) {
      console.log(`    ${String(d.kind).padEnd(4)} ${String(d.part).padEnd(14)} 你 ${JSON.stringify(d.mine).padEnd(16)} 参考 ${JSON.stringify(d.ref).padEnd(16)} 偏 ${d.dist}px`)
    }
    const nonGeo = refReport.diffs.filter((x) => x.dist == null)
    if (nonGeo.length) {
      console.log(`    另有 ${nonGeo.length} 处 rot/sc/z 差异：` + nonGeo.slice(0, 6).map((d) => `${d.part}.${d.kind}`).join('、'))
    }
  }
  console.log('')
}

process.exit(fails.length ? 1 : 0)
