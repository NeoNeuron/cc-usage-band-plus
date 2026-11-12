import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Git, Info, Limit, Measure, Style, Todo, TurnTokens } from '../types'

const measure = atom({ plugin: 'usage-band-plus', key: 'measure' } as const, null)
const turn = atom({ plugin: 'usage-band-plus', key: 'turn' } as const, null)
const now = atom({ plugin: 'usage-band-plus', key: 'now' } as const, 0)
const phase = atom({ plugin: 'usage-band-plus', key: 'phase' } as const, 0)
const style = atom({ plugin: 'usage-band-plus', key: 'style' } as const, 'unicode')
const info = atom({ plugin: 'usage-band-plus', key: 'info' } as const, { model: null, effort: null })
const git = atom({ plugin: 'usage-band-plus', key: 'git' } as const, null)
const todos = atom({ plugin: 'usage-band-plus', key: 'todos' } as const, [])

// One hue per metric; RED takes over only when a metric is in trouble
const HUE = { five: '#5cc4d6', seven: '#e8a25f', ctx: '#9aa5f5', cache: '#72cf9f' }
// The info row: model and branch in cyan, the git frame in magenta, todos amber until all are done
const TINT = { model: '#5cc4d6', git: '#c792ea', branch: '#5cc4d6', stat: '#e8a25f', doing: '#e8a25f', done: '#72cf9f' }
const RED = '#e5685f'
const TRACK = '#4a4f5c'
const FRAME_MS = 200
const PREVIEW = 'usage-band-plus-preview'

export const GLYPHS: Record<Style, { ctx: string; hit: string; fill: string; track: string }> = {
  nerd: { ctx: '\u{F0328} ', hit: '\u{F04FE} ', fill: '■', track: '■' },
  unicode: { ctx: '≡ ', hit: '● ', fill: '■', track: '■' },
  ascii: { ctx: 'ctx ', hit: 'hit ', fill: '#', track: '-' },
}

// Terminals known to ship Nerd Font symbols without the user installing a font
const NERD_BUILTIN = new Set(['ghostty'])

export const detectStyle = (setting: string, termProgram: string | undefined): Style => {
  if (setting === 'nerd' || setting === 'unicode' || setting === 'ascii') return setting
  return NERD_BUILTIN.has((termProgram ?? '').toLowerCase()) ? 'nerd' : 'unicode'
}

export const fmtTokens = (n: number): string => {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${+(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}K`
  return String(n)
}

export const fmtLeft = (ms: number): string => {
  const mins = Math.max(0, Math.round(ms / 60_000))
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  if (d > 0) return `${d}d${h}h`
  if (h > 0) return `${h}h${m}m`
  return `${m}m`
}

export const hitRate = (t: TurnTokens): number | null => {
  const total = t.input + t.cacheRead + t.cacheWrite
  return total === 0 ? null : Math.round((t.cacheRead / total) * 100)
}

// Blend a #rrggbb color toward white (t > 0) or black (t < 0) by |t|
export const lighten = (hex: string, t: number): string => {
  const n = parseInt(hex.slice(1), 16)
  const target = t >= 0 ? 255 : 0
  const ch = (v: number) => Math.round(v + (target - v) * Math.abs(t)).toString(16).padStart(2, '0')
  return `#${ch((n >> 16) & 255)}${ch((n >> 8) & 255)}${ch(n & 255)}`
}

// Nearest xterm-256 color, to preview how a 256-color terminal shows the band
export const to256 = (hex: string): string => {
  const n = parseInt(hex.slice(1), 16)
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const
  const levels = [0, 95, 135, 175, 215, 255]
  const nearest = (v: number) => levels.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a))
  const cube = rgb.map(nearest)
  const avg = (rgb[0] + rgb[1] + rgb[2]) / 3
  const g = Math.min(238, Math.max(8, 8 + Math.round((avg - 8) / 10) * 10))
  const dist = (c: readonly number[]) => c.reduce((s, v, i) => s + (v - rgb[i]!) ** 2, 0)
  const pick = dist(cube) <= dist([g, g, g]) ? cube : [g, g, g]
  return `#${pick.map(v => v.toString(16).padStart(2, '0')).join('')}`
}

export type Span = { text: string; color?: string; dim?: boolean }
export type Look = { style: Style; colors: 'true' | '256' }

const SEP: Span = { text: '  ' }

export const width = (spans: Span[]) => spans.reduce((n, s) => n + [...s.text].length, 0)

// A bar whose filled part runs from a deep shade of its color to a bright one,
// with a soft highlight sweeping left to right on top
export const bar = (pct: number, cells: number, color: string, frame: number, s: Style = 'unicode'): Span[] => {
  const g = GLYPHS[s]
  const filled = Math.max(pct > 0 ? 1 : 0, Math.min(cells, Math.round((pct / 100) * cells)))
  // Same period for every bar, so all highlights travel in step
  const pos = frame % (cells + 5)
  const spans: Span[] = []
  for (let i = 0; i < filled; i++) {
    const shade = filled === 1 ? 0 : -0.15 + (0.35 * i) / (filled - 1)
    const glow = i === pos ? 0.55 : i === pos - 1 || i === pos + 1 ? 0.25 : 0
    spans.push({ text: g.fill, color: lighten(lighten(color, shade), glow) })
  }
  if (cells > filled) spans.push({ text: g.track.repeat(cells - filled), color: TRACK })
  return spans
}

// detail 2: bars + countdowns; 1: no bars; 0: bare numbers
export const layout = (
  m: Measure | null,
  t: TurnTokens | null,
  at: number,
  detail: 0 | 1 | 2,
  frame = 0,
  look: Look = { style: 'unicode', colors: 'true' },
): Span[] => {
  const g = GLYPHS[look.style]
  const groups: Span[][] = []

  const limit = (label: string, l: Limit | undefined, hue: string) => {
    if (!l) return
    const pct = Math.round(l.percentUsed)
    const color = pct >= 80 ? RED : hue
    const out: Span[] = [{ text: `${label} `, color }]
    if (detail === 2) out.push(...bar(pct, 8, color, frame, look.style), { text: ' ' })
    out.push({ text: `${pct}%`, color })
    if (detail >= 1 && l.resetsAt) out.push({ text: ` · ${fmtLeft(Date.parse(l.resetsAt) - at)}`, dim: true })
    groups.push(out)
  }
  limit('5h', m?.rateLimits.find(l => l.kind === 'five_hour'), HUE.five)
  limit('7d', m?.rateLimits.find(l => l.kind === 'seven_day'), HUE.seven)

  if (m) {
    const pct = m.context.percent ?? 0
    const color = pct >= 80 ? RED : HUE.ctx
    groups.push([
      { text: g.ctx, color },
      { text: fmtTokens(m.context.tokens ?? 0), color },
      { text: `/${fmtTokens(m.context.window)}`, dim: true },
    ])
  }

  const hit = t ? hitRate(t) : null
  if (hit !== null) {
    const color = hit < 50 ? RED : HUE.cache
    groups.push([
      { text: g.hit, color },
      { text: `${hit}%`, color },
    ])
  }

  const spans = groups.flatMap((grp, i) => (i === 0 ? grp : [SEP, ...grp]))
  return look.colors === '256' ? spans.map(s => (s.color ? { ...s, color: to256(s.color) } : s)) : spans
}

const fit = (m: Measure | null, t: TurnTokens | null, at: number, cols: number, frame: number, look: Look) =>
  ([2, 1, 0] as const).map(d => layout(m, t, at, d, frame, look)).find(s => width(s) <= cols) ??
  layout(m, t, at, 0, frame, look)

// ---- The info row: model · effort, git status, todo progress

// `claude-opus-5-5` reads `Opus 5.5`; a name `/model` already made readable is kept
export const fmtModel = (raw: string): string => {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[(\w+)\])?$/.exec(raw.trim())
  if (!m) return raw.trim()
  const [, family = '', major, minor, variant] = m
  return `${family[0]!.toUpperCase()}${family.slice(1)} ${major}${minor ? `.${minor}` : ''}${variant ? ` ${variant.toUpperCase()}` : ''}`
}

// Reads `git status --porcelain=v2 --branch`
export const parseGitStatus = (stdout: string): Git => {
  const g: Git = { branch: '', modified: 0, staged: 0, untracked: 0, conflicts: 0, ahead: 0, behind: 0 }
  let oid = ''
  for (const line of stdout.split('\n')) {
    if (line.startsWith('# branch.oid ')) oid = line.slice(13).trim()
    else if (line.startsWith('# branch.head ')) g.branch = line.slice(14).trim()
    else if (line.startsWith('# branch.ab ')) {
      const ab = /\+(\d+) -(\d+)/.exec(line)
      if (ab) [g.ahead, g.behind] = [Number(ab[1]), Number(ab[2])]
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      if (line[2] !== '.') g.staged++
      if (line[3] !== '.') g.modified++
    } else if (line.startsWith('u ')) g.conflicts++
    else if (line.startsWith('? ')) g.untracked++
  }
  if (g.branch === '(detached)') g.branch = /^[0-9a-f]{7,}$/.test(oid) ? oid.slice(0, 7) : 'detached'
  return g
}

type Loose = Record<string, unknown>
const isStatus = (v: unknown): v is Todo['status'] => v === 'pending' || v === 'in_progress' || v === 'completed'

// The list after one answered TodoWrite, TaskCreate or TaskUpdate call; the same list when the
// call changed nothing the band shows
export const applyTodoCall = (list: readonly Todo[], tool: string, input: Loose, result: Loose): Todo[] => {
  if (tool === 'TodoWrite') {
    const next = Array.isArray(result.newTodos) ? (result.newTodos as Loose[]) : []
    return next.map((t, i) => ({ id: String(i), subject: String(t.content ?? ''), status: isStatus(t.status) ? t.status : 'pending' }))
  }
  if (tool === 'TaskCreate') {
    const task = result.task as Loose | undefined
    if (!task || task.id === undefined) return [...list]
    const made: Todo = { id: String(task.id), subject: String(task.subject ?? input.subject ?? ''), status: 'pending' }
    return [...list.filter(t => t.id !== made.id), made]
  }
  if (tool === 'TaskUpdate' && result.success === true) {
    const id = String(result.taskId ?? input.taskId)
    if (input.status === 'deleted') return list.filter(t => t.id !== id)
    // A task made before the mod loaded is first heard of here
    const known = list.find(t => t.id === id) ?? { id, subject: `#${id}`, status: 'pending' as const }
    const next: Todo = {
      id,
      subject: typeof input.subject === 'string' ? input.subject : known.subject,
      status: isStatus(input.status) ? input.status : known.status,
    }
    return list.some(t => t.id === id) ? list.map(t => (t.id === id ? next : t)) : [...list, next]
  }
  return [...list]
}

const SUBJECT_MAX = 40
const clip = (v: string, max: number, more: string) => {
  const chars = [...v]
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}${more}` : v
}
const MARKS: Record<Style, { doing: string; done: string; up: string; down: string; more: string }> = {
  nerd: { doing: '▸', done: '✓', up: '↑', down: '↓', more: '…' },
  unicode: { doing: '▸', done: '✓', up: '↑', down: '↓', more: '…' },
  ascii: { doing: '>', done: 'ok', up: '^', down: 'v', more: '...' },
}

// drop 0: everything; 1: no todo subject; 2: no ahead/behind; 3: no file counts; 4: no effort
export const infoLayout = (
  i: Info,
  g: Git | null,
  list: readonly Todo[],
  drop: 0 | 1 | 2 | 3 | 4 = 0,
  look: Look = { style: 'unicode', colors: 'true' },
): Span[] => {
  const k = MARKS[look.style]
  const groups: Span[][] = []

  if (i.model) {
    const out: Span[] = [{ text: fmtModel(i.model), color: TINT.model }]
    if (i.effort && drop < 4) out.push({ text: ` · ${i.effort}`, dim: true })
    groups.push(out)
  }

  if (g) {
    const isDirty = g.modified + g.staged + g.untracked + g.conflicts > 0
    const stats: string[] = []
    if (drop < 3) {
      if (g.conflicts) stats.push(`✗${g.conflicts}`.replace('✗', look.style === 'ascii' ? 'x' : '✗'))
      if (g.modified) stats.push(`!${g.modified}`)
      if (g.staged) stats.push(`+${g.staged}`)
      if (g.untracked) stats.push(`?${g.untracked}`)
    }
    if (drop < 2) {
      if (g.ahead) stats.push(`${k.up}${g.ahead}`)
      if (g.behind) stats.push(`${k.down}${g.behind}`)
    }
    const out: Span[] = [
      { text: 'git:(', color: TINT.git },
      { text: `${g.branch}${isDirty ? '*' : ''}`, color: TINT.branch },
    ]
    if (stats.length) out.push({ text: ` ${stats.join(' ')}`, color: TINT.stat })
    out.push({ text: ')', color: TINT.git })
    groups.push(out)
  }

  if (list.length) {
    const done = list.filter(t => t.status === 'completed').length
    const doing = list.find(t => t.status === 'in_progress')
    const count = `(${done}/${list.length})`
    if (doing) {
      const subject = clip(doing.subject, SUBJECT_MAX, k.more)
      groups.push([
        { text: drop < 1 && subject ? `${k.doing} ${subject} ` : `${k.doing} `, color: TINT.doing },
        { text: count, dim: true },
      ])
    } else if (done === list.length) {
      groups.push([{ text: `${k.done} ${done}/${list.length}`, color: TINT.done }])
    } else {
      groups.push([{ text: `${done}/${list.length} todos`, dim: true }])
    }
  }

  const spans = groups.flatMap((grp, n) => (n === 0 ? grp : [SEP, ...grp]))
  return look.colors === '256' ? spans.map(s => (s.color ? { ...s, color: to256(s.color) } : s)) : spans
}

export const fitInfo = (
  i: Info,
  g: Git | null,
  list: readonly Todo[],
  cols: number,
  look: Look,
): Span[] =>
  ([0, 1, 2, 3, 4] as const).map(d => infoLayout(i, g, list, d, look)).find(s => width(s) <= cols) ??
  infoLayout(i, g, list, 4, look)

export const infoText = (i: Info, g: Git | null, list: readonly Todo[]) =>
  infoLayout(i, g, list)
    .map(s => s.text)
    .join('')

// ---- Desktop: the band is one SVG drawn as a plain image. The SMIL shine runs in an image too,
// and an image redraws in place, where an interactive (framed) SVG reloads its frame and blinks
// the whole band on every redraw.

const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// CAP: the band the figures' cap height occupies (Inter 13px on baseline 19.5);
// icons, dots and the inner rule are sized to it so the row reads one height
const CAP = { top: 9.75, h: 10 }
const D = { h: 30, gap: 30, inner: 7, sm: 13, md: 13, base: 13, barW: 76, barH: 6 }
// Advance widths in em for Inter with tabular figures (SF Pro, the fallback, runs within a few %).
// Each text also sets textLength to this width, so a font that runs wider or narrower only
// changes letter spacing and never pushes into the next element.
const ADVANCE: Record<string, number> = { h: 0.58, d: 0.6, m: 0.9, K: 0.64, M: 0.84, '%': 0.84, '/': 0.36, '.': 0.27, ' ': 0.26 }
// Extra space between letters, in px; textLength spreads it evenly across each string
const TRACKING = 0.2
const textW = (v: string, size: number) =>
  [...v].reduce((w, c) => w + (c >= '0' && c <= '9' ? 0.62 : (ADVANCE[c] ?? 0.6)), 0) * size +
  TRACKING * Math.max(0, [...v].length - 1)

// Text tinted toward the hue: deeper on light backgrounds, lighter on dark ones
const pinW = (v: string, size: number) => `textLength="${textW(v, size).toFixed(1)}" lengthAdjust="spacing"`
const ink = (hue: string, x: number, y: number, v: string, size: number) =>
  `<text x="${x}" y="${y}" font-size="${size}" ${pinW(v, size)} class="ink" style="--l:${lighten(hue, -0.38)};--d:${lighten(hue, 0.25)}">${esc(v)}</text>`
const mute = (x: number, y: number, v: string, size: number) =>
  `<text x="${x}" y="${y}" font-size="${size}" ${pinW(v, size)} class="mute">${esc(v)}</text>`

// stat: type, icons and rules; motion: bars and dots with their shine
type Layers = { stat: string; motion: string }
type Group = { width: number; draw: (x: number) => Layers }

// 5h 60% ▬▬▬▬── 1h49m: the figure first, so the state reads before the bar
// 5h ▬▬▬▬▬▬──── 69% │ 1h31m: label, bar, figure, then when it resets
const limitGroup = (id: string, label: string, l: Limit, hue: string, at: number): Group => {
  const pct = Math.round(l.percentUsed)
  const color = pct >= 80 ? RED : hue
  const pctText = `${pct}%`
  const left = l.resetsAt ? fmtLeft(Date.parse(l.resetsAt) - at) : ''
  const labelW = textW(label, D.base) + D.inner
  const pctW = textW(pctText, D.base)
  const width = labelW + D.barW + D.inner + pctW + (left ? D.inner * 2 + 1 + textW(left, D.sm) : 0)
  const fillW = Math.max(pct > 0 ? D.barH : 0, Math.min(D.barW, (D.barW * pct) / 100))
  return {
    width,
    draw: x => {
      const bx = x + labelW
      const y = (D.h - D.barH) / 2
      const r = D.barH / 2
      const px = bx + D.barW + D.inner
      const motion = [
        `<defs><clipPath id="c-${id}"><rect x="${bx}" y="${y}" width="${fillW}" height="${D.barH}" rx="${r}"/></clipPath></defs>`,
        `<rect x="${bx}" y="${y}" width="${D.barW}" height="${D.barH}" rx="${r}" class="track" style="--h:${color}"/>`,
        `<rect x="${bx}" y="${y}" width="${fillW}" height="${D.barH}" rx="${r}" fill="${lighten(color, -0.12)}"/>`,
        // The shine crosses the whole bar on one shared clock and shows only over the fill,
        // so both bars' shines sit at the same spot at every moment
        `<g clip-path="url(#c-${id})"><rect y="${y}" width="18" height="${D.barH}" fill="url(#shine)">` +
          `<animate attributeName="x" values="${bx - 18};${bx + D.barW};${bx + D.barW}" keyTimes="0;0.62;1" dur="2.6s" repeatCount="indefinite"/></rect></g>`,
      ]
      const stat = [ink(color, x, 19.5, label, D.base), ink(color, px, 19.5, pctText, D.base)]
      if (left) {
        const rx = px + pctW + D.inner
        stat.push(`<rect x="${rx}" y="${CAP.top}" width="1" height="${CAP.h}" class="rule"/>`, mute(rx + 1 + D.inner, 19.5, left, D.sm))
      }
      return { stat: stat.join(''), motion: motion.join('') }
    },
  }
}

// Three stacked sheets: the context window
const layersIcon = (color: string) =>
  `<g fill="none" stroke="${color}" stroke-width="1.2" stroke-linejoin="round">` +
  `<path d="M5 0.6 L9.4 2.8 L5 5 L0.6 2.8 Z" fill="${color}" fill-opacity="0.25"/>` +
  `<path d="M0.6 5.2 L5 7.4 L9.4 5.2"/><path d="M0.6 7.2 L5 9.4 L9.4 7.2"/></g>`

// A target: how much of the prompt the cache hit
const targetIcon = (color: string) =>
  `<g fill="none" stroke="${color}" stroke-width="1.2">` +
  `<circle cx="5" cy="5" r="4.4"/><circle cx="5" cy="5" r="2.1"/><circle cx="5" cy="5" r="0.7" fill="${color}"/></g>`

// Icons are drawn in a CAP.h square, outer stroke edge included
const ICON = CAP.h

// icon · NUMBER suffix
const typeGroup = (icon: (c: string) => string, hue: string, num: string, suffix: string): Group => {
  const lw = ICON + 6
  const nw = textW(num, D.md)
  const sw = suffix ? textW(suffix, D.sm) + 1 : 0
  return {
    width: lw + nw + sw,
    draw: x => {
      const nx = x + lw
      return {
        stat:
          `<g transform="translate(${x} ${CAP.top})">${icon(lighten(hue, -0.15))}</g>` +
          ink(hue, nx, 19.5, num, D.md) +
          (suffix ? mute(nx + nw + 1, 19.5, suffix, D.sm) : ''),
        motion: '',
      }
    },
  }
}

// Context as a 2×10 dot matrix: one dot per 1/20 of the window (50K of 1M), filling the top
// row left to right before the bottom one, with the same shine over the lit dots
// Rows sit so the dots' outer edges meet the CAP band: CAP.top + r and CAP.top + CAP.h - r
const DOTS = { cols: 10, pitch: 5, r: 1.6, rows: [11.35, 18.15] }
const ctxGroup = (hue: string, tokens: number, window: number, pct: number): Group => {
  const lit = Math.min(DOTS.cols * 2, Math.round((pct / 100) * DOTS.cols * 2))
  const num = fmtTokens(tokens)
  const suffix = `/${fmtTokens(window)}`
  const lw = ICON + 6
  const matrixW = DOTS.cols * DOTS.pitch
  return {
    width: lw + matrixW + D.inner + textW(num, D.md) + 1 + textW(suffix, D.sm),
    draw: x => {
      const mx = x + lw
      const dot = (i: number) =>
        `<circle cx="${mx + DOTS.pitch / 2 + (i % DOTS.cols) * DOTS.pitch}" cy="${DOTS.rows[Math.floor(i / DOTS.cols)]}" r="${DOTS.r}"/>`
      const on = Array.from({ length: lit }, (_, i) => dot(i)).join('')
      const off = Array.from({ length: DOTS.cols * 2 - lit }, (_, i) => dot(lit + i)).join('')
      const nx = mx + matrixW + D.inner
      return {
        stat:
          `<g transform="translate(${x} ${CAP.top})">${layersIcon(lighten(hue, -0.15))}</g>` +
          ink(hue, nx, 19.5, num, D.md) +
          mute(nx + textW(num, D.md) + 1, 19.5, suffix, D.sm),
        motion:
          `<defs><clipPath id="c-ctx">${on}</clipPath></defs>` +
          `<g class="track" style="--h:${hue}">${off}</g>` +
          `<g fill="${lighten(hue, -0.12)}">${on}</g>` +
          `<g clip-path="url(#c-ctx)"><rect y="8" width="18" height="14" fill="url(#shine)">` +
          `<animate attributeName="x" values="${mx - 18};${mx + matrixW};${mx + matrixW}" keyTimes="0;0.62;1" dur="2.6s" repeatCount="indefinite"/></rect></g>`,
      }
    },
  }
}

// An image takes its color scheme from the app; a frame (should the band ever be framed) whose color scheme differs from the app's
// gets an opaque canvas behind it (white in a dark app). Declaring both schemes lets it follow the
// app and stay transparent.
const SVG_HEAD =
  `<style>` +
  `:root{color-scheme:light dark;background:transparent}` +
  `text{font-family:Inter,"SF Pro Text",system-ui,-apple-system,"Segoe UI",sans-serif;font-weight:500;font-feature-settings:"tnum","cv05"}` +
  `.track{fill:var(--h);fill-opacity:.22}` +
  `.ink{fill:var(--l)}.mute{fill:#8b8f97;font-weight:400}.rule{fill:#000;fill-opacity:.1}.sep{fill:#000;fill-opacity:.2}` +
  `@media (prefers-color-scheme:dark){.ink{fill:var(--d)}.mute{fill:#9aa0a8}.rule{fill:#fff;fill-opacity:.13}.sep{fill:#fff;fill-opacity:.22}}` +
  `</style>` +
  `<defs><linearGradient id="shine" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/>` +
  `<stop offset=".5" stop-color="#fff" stop-opacity=".8"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>`

const wrap = (width: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${D.h}" viewBox="0 0 ${width} ${D.h}" style="color-scheme:light dark;background:transparent">${SVG_HEAD}${body}</svg>`

export type Part = Layers & { width: number; alt: string }

export const desktopParts = (m: Measure | null, t: TurnTokens | null, at: number): Part[] => {
  const groups: { g: Group; alt: string }[] = []
  const five = m?.rateLimits.find(l => l.kind === 'five_hour')
  const seven = m?.rateLimits.find(l => l.kind === 'seven_day')
  if (five) groups.push({ g: limitGroup('5h', '5h', five, HUE.five, at), alt: `5-hour limit ${Math.round(five.percentUsed)}% used` })
  if (seven) groups.push({ g: limitGroup('7d', '7d', seven, HUE.seven, at), alt: `7-day limit ${Math.round(seven.percentUsed)}% used` })
  if (m) {
    const pct = m.context.percent ?? 0
    groups.push({
      g: ctxGroup(pct >= 80 ? RED : HUE.ctx, m.context.tokens ?? 0, m.context.window, pct),
      alt: `context ${fmtTokens(m.context.tokens ?? 0)} of ${fmtTokens(m.context.window)}`,
    })
  }
  const hit = t ? hitRate(t) : null
  if (hit !== null) groups.push({ g: typeGroup(targetIcon, hit < 50 ? RED : HUE.cache, `${hit}%`, ''), alt: `cache hit ${hit}%` })
  return groups.map(({ g, alt }) => {
    const width = Math.ceil(g.width + 2)
    return { ...g.draw(1), width, alt }
  })
}

// One SVG for the whole band, so every shine runs on the same clock. Groups sit D.gap apart
// with a hairline centred in each gap; the one inside a limit group is shorter and fainter.
export const desktopSvg = (m: Measure | null, t: TurnTokens | null, at: number) => {
  let x = 0
  const body: string[] = []
  desktopParts(m, t, at).forEach((p, i) => {
    if (i > 0) body.push(`<rect x="${Math.round(x - D.gap / 2)}" y="7" width="1" height="16" class="sep"/>`)
    body.push(`<g transform="translate(${x} 0)">${p.stat}${p.motion}</g>`)
    x += p.width + D.gap
  })
  const width = Math.max(1, Math.ceil(x - D.gap))
  return { svg: wrap(width, body.join('')), width, height: D.h }
}

export const describe = (
  m: Measure | null,
  t: TurnTokens | null,
  i: Info = { model: null, effort: null },
  g: Git | null = null,
  list: readonly Todo[] = [],
) => {
  const parts: string[] = []
  if (i.model) parts.push(`model ${fmtModel(i.model)}${i.effort ? `, effort ${i.effort}` : ''}`)
  if (g) {
    const counts = [
      g.conflicts && `${g.conflicts} in conflict`,
      g.modified && `${g.modified} modified`,
      g.staged && `${g.staged} staged`,
      g.untracked && `${g.untracked} untracked`,
      g.ahead && `${g.ahead} ahead`,
      g.behind && `${g.behind} behind`,
    ].filter(Boolean)
    parts.push(`git branch ${g.branch}${counts.length ? `: ${counts.join(', ')}` : ', clean'}`)
  }
  if (list.length) {
    const doing = list.find(x => x.status === 'in_progress')
    const done = list.filter(x => x.status === 'completed').length
    parts.push(`${done} of ${list.length} todos done${doing ? `, now: ${doing.subject}` : ''}`)
  }
  for (const l of m?.rateLimits ?? []) {
    if (l.kind === 'five_hour') parts.push(`5-hour limit ${Math.round(l.percentUsed)}% used`)
    if (l.kind === 'seven_day') parts.push(`7-day limit ${Math.round(l.percentUsed)}% used`)
  }
  if (m) parts.push(`context ${fmtTokens(m.context.tokens ?? 0)} of ${fmtTokens(m.context.window)}`)
  const hit = t ? hitRate(t) : null
  if (hit !== null) parts.push(`cache hit ${hit}%`)
  return parts.join(', ')
}

// The desktop app redraws the band, and its frame blinks, on every write a drawing reads. So a
// reading is only written when it changes what the band shows: a new token count that rounds to
// the same figure, or a clock tick that leaves every countdown as it was, writes nothing.
const shown = (m: Measure | null, t: TurnTokens | null, at: number) => desktopSvg(m, t, at).svg

const tick = async ($: EngineInterface) => {
  const at = await $.clock.now()
  const [m, t, was] = [await read($, measure), await read($, turn), await read($, now)]
  if (was && shown(m, t, was) === shown(m, t, at)) return
  await update($, now, () => at)
}

const setMeasure = async ($: EngineInterface, next: Measure) => {
  const [m, t, at] = [await read($, measure), await read($, turn), await read($, now)]
  if (m && shown(m, t, at) === shown(next, t, at)) return
  await update($, measure, () => next)
}

const setTurn = async ($: EngineInterface, next: TurnTokens) => {
  const [m, t, at] = [await read($, measure), await read($, turn), await read($, now)]
  if (t && shown(m, t, at) === shown(m, next, at)) return
  await update($, turn, () => next)
}

// The info row's values are written only when they differ, for the same reason
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

const setInfo = async ($: EngineInterface, patch: Partial<Info>) => {
  const was = await read($, info)
  const next = { ...was, ...patch }
  if (!same(was, next)) await update($, info, () => next)
}

const GIT_STATUS = ['git', '--no-optional-locks', 'status', '--porcelain=v2', '--branch'] as const

const refreshGit = async ($: EngineInterface) => {
  let next: Git | null = null
  try {
    const ran = await $.process.run(GIT_STATUS, { timeoutMs: 3000 })
    if (ran.exitCode === 0) next = parseGitStatus(ran.stdout)
  } catch {
    // No git, or it ran past the timeout: the band shows no git group
  }
  if (!same(await read($, git), next)) await update($, git, () => next)
}

// Calls the model made together answer together: each is applied to the list the one before
// left, never to a list read before that one wrote
let todoWrites: Promise<void> = Promise.resolve()
const recordTodoCall = ($: EngineInterface, tool: string, input: Loose, result: Loose) => {
  todoWrites = todoWrites
    .catch(() => {})
    .then(async () => {
      const was = await read($, todos)
      const list = applyTodoCall(was, tool, input, result)
      if (!same(was, list)) await update($, todos, () => list)
    })
  return todoWrites
}

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
const asEffort = (v: unknown): string | null => {
  if (typeof v === 'number') return String(v)
  const s = typeof v === 'string' ? v.trim().toLowerCase() : ''
  return EFFORTS.has(s) ? s : null
}

// The effort `/effort` saved for one model, in the settings' `modelSettings`, which wins over the
// session-wide `effortLevel`. The model may be an id, an id with a variant (`[1m]`) or a name.
export const modelEffort = (modelSettings: unknown, model: string): string | null => {
  if (!modelSettings || typeof modelSettings !== 'object') return null
  const table = modelSettings as Record<string, { effortLevel?: unknown } | undefined>
  const bare = (v: string) => fmtModel(v.trim().replace(/\[\w+\]$/, '')).toLowerCase()
  const key = Object.keys(table).find(k => k === model) ?? Object.keys(table).find(k => bare(k) === bare(model))
  return key ? asEffort(table[key]?.effortLevel) : null
}

const GIT_DEBOUNCE_MS = 500

// One git run at a time: calls that arrive while one is waiting or running fold into one more.
// A reload starts these over with the module.
let isGitQueued = false
let isGitRunning = false
const scheduleGit = ($: EngineInterface) => {
  if (isGitQueued) return
  isGitQueued = true
  $.clock.after(GIT_DEBOUNCE_MS, () => {
    void (async () => {
      if (isGitRunning) {
        isGitQueued = false
        return scheduleGit($)
      }
      isGitQueued = false
      isGitRunning = true
      try {
        await refreshGit($)
      } finally {
        isGitRunning = false
      }
    })()
  })
}

// Shown by the preview when the session has no reading yet
const SAMPLE_MEASURE: Measure = {
  context: { tokens: 176_000, window: 1_000_000, percent: 18 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 42 },
    { kind: 'seven_day', percentUsed: 43 },
  ],
}
const SAMPLE_TURN: TurnTokens = { input: 900, output: 2_000, cacheRead: 170_000, cacheWrite: 1_000 }
const SAMPLE_INFO: Info = { model: 'claude-opus-5-5', effort: 'high' }
const SAMPLE_GIT: Git = { branch: 'main', modified: 2, staged: 1, untracked: 3, conflicts: 0, ahead: 1, behind: 0 }
const SAMPLE_TODOS: Todo[] = [
  { id: '1', subject: 'Read the code', status: 'completed' },
  { id: '2', subject: 'Fix the bug', status: 'in_progress' },
  { id: '3', subject: 'Run the tests', status: 'pending' },
]

const PROFILES: { name: string; look: Look }[] = [
  { name: 'Ghostty', look: { style: 'nerd', colors: 'true' } },
  { name: 'iTerm2 / Warp / WezTerm / kitty', look: { style: 'unicode', colors: 'true' } },
  { name: 'macOS Terminal (256 colors)', look: { style: 'unicode', colors: '256' } },
  { name: 'ascii fallback', look: { style: 'ascii', colors: '256' } },
]

// Icon set override, read from USAGE_BAND_ICONS. It is an environment variable rather than a
// plugin option so a fresh install has nothing to configure.
const ICONS_ENV = 'USAGE_BAND_ICONS'

export const WELCOME =
  'usage-band-plus is on: model, effort, git status and todos, over your 5h and 7d limits, context window and cache hit rate, now show above the prompt. ' +
  'The limits fill in after Claude’s first reply.'

export const register: Register = on => {
  let setting = 'auto'
  // The terminal animates by redrawing; started by its first draw, so a desktop-only session
  // never runs it. A reload drops the timer and this flag together.
  let isAnimating = false
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    setting = ((await $.env.get('USAGE_BAND_ICONS')) ?? 'auto').trim().toLowerCase() || 'auto'
    const term = await $.env.get('TERM_PROGRAM')
    await update($, style, () => detectStyle(setting, term))
    await $.command.register({
      name: PREVIEW,
      description: 'Preview how the usage band looks in different terminals',
    })
    // One welcome after install, so a new user knows what appeared above the prompt
    if ((await $.store.get('welcomed')) !== true) {
      await $.store.set('welcomed', true)
      $.ui.toast(WELCOME, { timeoutMs: 12_000 })
    }
    const usage = await $.session.usage()
    await setMeasure($, { context: usage.context, rateLimits: usage.rateLimits })
    await tick($)
    $.clock.every(60_000, () => {
      void tick($)
      scheduleGit($)
    })
    scheduleGit($)
    // The first step of a turn brings the model and effort in force; until then, what the session
    // is set to. A read that fails leaves the row to that first step.
    try {
      const model = await $.session.model()
      const effort =
        modelEffort(await $.settings.read({ key: 'modelSettings' }), model) ??
        asEffort(await $.settings.read({ key: 'effortLevel' })) ??
        asEffort(await $.env.get('CLAUDE_CODE_EFFORT_LEVEL'))
      await setInfo($, { model, ...(effort ? { effort } : {}) })
    } catch {
      // Shown from the first step on
    }
    return result
  })

  on('session.measure', async ($, e, next) => {
    const m: Measure = {
      context: { tokens: e.context.tokens, window: e.context.window, percent: e.context.percent },
      rateLimits: e.rateLimits.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt })),
    }
    await setMeasure($, m)
    await tick($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // Main loop only; subagent runs raise their own turn.complete
    if (e.agentId === undefined && e.usage) {
      const u = e.usage
      await setTurn($, {
        input: u.input_tokens,
        output: u.output_tokens,
        cacheRead: u.cache_read_input_tokens,
        cacheWrite: u.cache_creation_input_tokens,
      })
    }
    if (e.agentId === undefined) scheduleGit($)
    return next(e)
  })

  // Main loop only: the model and effort each request goes out with
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) await setInfo($, { model: e.model, effort: asEffort(e.effort) })
    return yield* next(e)
  })

  // Subagents write the session's task list too, so their calls count
  on('tool.call', { tool: ['TodoWrite', 'TaskCreate', 'TaskUpdate'] }, async ($, e, next) => {
    const ran = await next(e)
    // The call has run: nothing here may fail the hook and have it answered again
    try {
      if (ran.deny === undefined && ran.isError !== true && ran.result) {
        await recordTodoCall($, e.tool, e as Loose, ran.result as Loose)
      }
    } catch {
      // The band keeps the list it had
    }
    return ran
  })

  // Tools that can change the working tree
  on('tool.call', { tool: ['Bash', 'Edit', 'Write', 'NotebookEdit'] }, async ($, e, next) => {
    const ran = await next(e)
    try {
      scheduleGit($)
    } catch {
      // The next timer tick reads git instead
    }
    return ran
  })

  on('command.run', { command: PREVIEW }, async () => ({
    text: `usage-band-plus style preview (${ICONS_ENV}: ${setting})`,
  }))

  on('ui.render', { component: 'CommandOutput', props: { command: PREVIEW } }, async ($, e) => {
    const m = (await read($, measure)) ?? SAMPLE_MEASURE
    const t = (await read($, turn)) ?? SAMPLE_TURN
    const at = await read($, now)
    const current = await read($, style)
    const i = await read($, info)
    const shownInfo = i.model ? i : SAMPLE_INFO
    const g = (await read($, git)) ?? SAMPLE_GIT
    const list = await read($, todos)
    const shownTodos = list.length ? list : SAMPLE_TODOS
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text dimColor>
          {ICONS_ENV}: {setting} → using {current}
        </Text>
        {PROFILES.map(p => (
          <Box key={p.name} flexDirection="column" marginTop={1}>
            <Text dimColor>{p.name}</Text>
            <Box flexDirection="row">
              {infoLayout(shownInfo, g, shownTodos, 0, p.look).map((s, n) => (
                <Text key={`i${n}`} color={s.color} dimColor={s.dim}>
                  {s.text}
                </Text>
              ))}
            </Box>
            <Box flexDirection="row">
              {layout(m, t, at, 2, 3, p.look).map((s, i) => (
                <Text key={`s${i}`} color={s.color} dimColor={s.dim}>
                  {s.text}
                </Text>
              ))}
            </Box>
          </Box>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const m = await read($, measure)
    const t = await read($, turn)
    const at = await read($, now)
    const i = await read($, info)
    const g = await read($, git)
    const list = await read($, todos)
    const hasUsage = m !== null || t !== null
    const hasInfo = i.model !== null || g !== null || list.length > 0
    if (e.props.hasSurvey || (!hasUsage && !hasInfo)) return next(e)

    // Desktop and mobile animate inside the SVG, so they never read the frame counter
    if (e.surface === 'desktop' || e.surface === 'mobile') {
      const { Box, Svg, Text } = $.ui.resolve(e)
      const { svg, width, height } = desktopSvg(m, t, at)
      return (
        <Box flexDirection="column" flexGrow={1} paddingX={1}>
          {hasInfo && (
            <Box flexDirection="row" justifyContent="center">
              <Text dimColor>{infoText(i, g, list)}</Text>
            </Box>
          )}
          {hasUsage && (
            <Box flexDirection="row" justifyContent="center">
              <Svg source={svg} alt={describe(m, t, i, g, list)} width={width} height={height} />
            </Box>
          )}
        </Box>
      )
    }

    if (!isAnimating) {
      isAnimating = true
      $.clock.every(FRAME_MS, () => {
        void update($, phase, f => (f ?? 0) + 1)
      })
    }
    const frame = await read($, phase)
    // The terminal font decides icons; other surfaces (vscode) get the plain set
    const s = e.surface === 'terminal' ? await read($, style) : 'unicode'
    const look: Look = { style: s, colors: 'true' }
    const cols = e.props.bodyColumns - 2
    const rows = [
      hasInfo ? fitInfo(i, g, list, cols, look) : [],
      hasUsage ? fit(m, t, at, cols, frame, look) : [],
    ]
      .filter(r => r.length > 0)
      // With room for one row, the usage row stays
      .slice(-Math.max(1, e.props.maxRows))
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column" paddingX={1}>
        {rows.map((spans, r) => (
          <Box key={`r${r}`} flexDirection="row" flexWrap="wrap">
            {spans.map((sp, n) => (
              <Text key={`s${n}`} color={sp.color} dimColor={sp.dim}>
                {sp.text}
              </Text>
            ))}
          </Box>
        ))}
      </Box>
    )
  })
}
