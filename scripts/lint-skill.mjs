#!/usr/bin/env node
/**
 * lint-skill.mjs — SKILL.md 的 frontmatter 体检（零依赖）
 *
 * 为什么需要它：frontmatter 只要坏一个字符，整个 skill 就是"unknown or no longer available"，
 * 而且报错时界面只说"不可用"，不说为什么。最常见的坏法就是 description 里带了未转义的引号：
 *
 *   description: "用代码做动画......保证"画面真的在动"。用户说"做个动画"时使用。"
 *                              ↑ 这里就结束了  ↑ 后面的全部变成非法 YAML
 *
 * 标准 YAML 双引号字符串里，内部 `"` 必须写成 `\"`。但写 skill 时很容易忘，
 * 因为中文稿件里的引号是「」或""，混进英文引号就炸。
 * 保险写法：用单引号包整体，内部一律用「」，或者干脆裸写不放引号。
 *
 * 用法：
 *   node lint-skill.mjs                      # 当前目录/脚本所在 skill 优先，找不到才扫 ~/.dsh/skills
 *   node lint-skill.mjs <目录或SKILL.md路径>  # 扫指定
 *   node lint-skill.mjs --all                # 强制扫 ~/.dsh/skills 下全部
 *   node lint-skill.mjs --all --json
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const json = argv.includes('--json')
const all = argv.includes('--all')
const targets = argv.filter((a) => !a.startsWith('--'))

const DEFAULT_ROOT = path.join(os.homedir(), '.dsh', 'skills')

async function collect(p) {
  const out = []
  const s = await stat(p).catch(() => null)
  if (!s) return out
  if (s.isFile()) { if (path.basename(p) === 'SKILL.md') out.push({ file: p, dir: path.dirname(p) }); return out }
  for (const name of await readdir(p)) {
    const full = path.join(p, name)
    const st = await stat(full).catch(() => null)
    if (!st) continue
    if (st.isDirectory()) out.push(...await collect(full))
    else if (name === 'SKILL.md') out.push({ file: full, dir: p })
  }
  return out
}

function lintFrontmatter(text) {
  const errors = []
  const warnings = []
  const raw = text

  // BOM 会让首个 --- 识别失败
  if (raw.charCodeAt(0) === 0xfeff) errors.push('文件带 UTF-8 BOM，首行 --- 不会被识别')

  const src = raw.replace(/^\uFEFF/, '')
  const lines = src.split(/\r?\n/)
  if (lines[0].trim() !== '---') {
    errors.push(`第一行必须是 ---（现在是 ${JSON.stringify(lines[0].slice(0, 20))}）`)
    return { errors, warnings, fields: {} }
  }
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
  if (end < 0) { errors.push('找不到结束的 ---'); return { errors, warnings, fields: {} } }

  const body = lines.slice(1, end)
  const fields = {}
  for (let i = 0; i < body.length; i++) {
    const line = body[i]
    const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (!m) continue                       // 缩进行、注释，跳过
    const [, key] = m
    let v = m[2].trim()

    // 块标量（>- / | 等）：把后续缩进行收集起来当内容，再判断
    if (/^[>|][-+]?$/.test(v)) {
      const parts = []
      let j = i + 1
      for (; j < body.length; j++) {
        const b = body[j]
        if (b.trim() === '') { parts.push(''); continue }
        if (!/^\s/.test(b)) break
        parts.push(b.trim())
      }
      i = j - 1
      v = parts.join(' ').replace(/\s+/g, ' ').trim()
      fields[key] = v
      if (!v) errors.push(`${key}: 块标量为空`)
      continue
    }

    fields[key] = v

    if (v.startsWith('"')) {
      if (!v.endsWith('"') || v.length < 2) {
        errors.push(`${key}: 以 " 开头但没有正常闭合`)
        continue
      }
      const inner = v.slice(1, -1)
      const bare = (inner.match(/(?<!\\)"/g) || []).length
      if (bare > 0) {
        const at = inner.indexOf('"')
        errors.push(`${key}: 双引号字符串里还有 ${bare} 个未转义的 " —— YAML 会在第一个 " 处截断。`
          + `位置约：…${inner.slice(Math.max(0, at - 14), at + 14)}…。`
          + '改用单引号包整体、内部用「」，或把内部 " 转义成 \\"')
      }
    } else if (v.startsWith("'")) {
      if (!v.endsWith("'") || v.length < 2) {
        errors.push(`${key}: 以 ' 开头但没有正常闭合`)
        continue
      }
      const inner = v.slice(1, -1)
      const bare = (inner.match(/''|'/g) || []).filter((s) => s === "'").length
      if (bare > 0) errors.push(`${key}: 单引号字符串内部的 ' 必须写成 ''`)
    } else {
      // 裸标量：不能出现 ": " 与 " #"
      if (/:\s/.test(v)) errors.push(`${key}: 裸标量里出现 ": "（加空格），YAML 会当成嵌套键。用引号包裹，或把冒号改成全角「：」`)
      if (/\s#/.test(v)) errors.push(`${key}: 裸标量里出现 " #"，会被当成注释截断`)
      if (v === '') warnings.push(`${key}: 值为空`)
    }
  }

  if (!fields.name) errors.push('缺字段 name')
  if (!fields.description) errors.push('缺字段 description')

  const desc = (fields.description || '').replace(/^['"]|['"]$/g, '')
  if (fields.description && desc.length < 20) warnings.push(`description 只有 ${desc.length} 字，触发匹配的概率会很低（建议 60–400 字）`)
  if (desc.length > 900) warnings.push(`description 有 ${desc.length} 字，过长可能被截断（建议 ≤ 900）`)

  return { errors, warnings, fields }
}

async function isSkillDir(dir) {
  const s = await stat(path.join(dir, 'SKILL.md')).catch(() => null)
  return !!s?.isFile()
}

// 无参时的默认范围：先看"我脚下"，再看"脚本自己在哪"，最后才回落到全局 skills 目录。
// 曾经写死只扫 ~/.dsh/skills，在 skill 目录里照着 SKILL.md 的命令跑会报"没找到 SKILL.md" ——
// 明明脚下就有一个，却因为 skill 没装进全局目录而扫空。
let roots = targets
if (!roots.length) {
  if (all) {
    roots = [DEFAULT_ROOT]
  } else {
    const here = path.dirname(fileURLToPath(import.meta.url))
    for (const c of [process.cwd(), path.dirname(here)]) {
      if (await isSkillDir(c)) { roots = [c]; break }
    }
    if (!roots.length) roots = [DEFAULT_ROOT]
  }
}

let files = []
for (const r of roots) files.push(...await collect(path.resolve(r)))
if (!files.length) {
  console.error(`✖ 在 ${roots.join(', ')} 下没找到 SKILL.md`)
  console.error('  想扫全局 skills 目录：node lint-skill.mjs --all')
  process.exit(1)
}

const results = []
for (const { file, dir } of files) {
  const text = await readFile(file, 'utf8')
  const { errors, warnings, fields } = lintFrontmatter(text)
  const dirName = path.basename(dir)
  if (fields.name) {
    const n = fields.name.replace(/^['"]|['"]$/g, '')
    if (n !== dirName) errors.push(`name "${n}" 与目录名 "${dirName}" 不一致（加载器通常以目录名寻址）`)
  }
  results.push({ file, dir, name: fields.name || null, errors, warnings })
}

if (json) {
  console.log(JSON.stringify(results, null, 2))
} else {
  let bad = 0
  for (const r of results) {
    const tag = r.errors.length ? '✖ FAIL' : r.warnings.length ? '⚠ WARN' : '✓ OK  '
    console.log(`${tag}  ${path.basename(r.dir)}`)
    for (const e of r.errors) console.log(`         ✖ ${e}`)
    for (const w of r.warnings) console.log(`         ⚠ ${w}`)
    if (r.errors.length) bad++
  }
  console.log(`\n${results.length} 个 skill，${bad} 个有致命错误`)
  process.exit(bad ? 1 : 0)
}
