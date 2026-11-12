import { expect, mock, test } from 'claude-code/testing'

import {
  applyTodoCall,
  bar,
  desktopSvg,
  detectStyle,
  fitInfo,
  fmtLeft,
  fmtModel,
  fmtTokens,
  hitRate,
  infoLayout,
  infoSvg,
  infoText,
  layout,
  modelEffort,
  parseGitStatus,
  to256,
  width,
} from '../hooks/register'
import type { Git, Measure, Todo } from '../types'

const BAND = {
  component: 'AbovePrompt',
  // The mount fills scroll and view; the band reads none of them
  props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 140 } as never,
} as const

test('formats tokens, countdowns and hit rate', async () => {
  expect(fmtTokens(950)).toBe('950')
  expect(fmtTokens(15_600)).toBe('15.6K')
  expect(fmtTokens(100_000)).toBe('100K')
  expect(fmtTokens(1_000_000)).toBe('1M')
  expect(fmtLeft((2 * 60 + 40) * 60_000)).toBe('2h40m')
  expect(fmtLeft((31 * 60) * 60_000)).toBe('1d7h')
  expect(hitRate({ input: 50, output: 10, cacheRead: 900, cacheWrite: 50 })).toBe(90)
  expect(hitRate({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })).toBe(null)
})

test('band shows limits, context and the last turn on terminal and desktop', async ($, on) => {
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('turn.complete', () => ({ text: '' }))

  await $.session.measure({
    context: { tokens: 100_000, window: 1_000_000, percent: 10 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 20 },
      { kind: 'seven_day', percentUsed: 58 },
    ],
    changed: ['context', 'rateLimits'],
  })
  await $.turn.complete({
    answer: 'ok',
    durationMs: 1000,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
    usage: {
      model: 'claude-opus-5-5',
      input_tokens: 50,
      output_tokens: 3_000,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 50,
    },
  })

  const desk = await $.ui.mount({ plugin: 'usage-band-plus', surface: 'desktop', ...BAND })
  // One SVG for the band, drawn as an image (a framed SVG blinks on every redraw), with hairlines
  // between the four groups
  const svg = await desk.find({ type: 'Svg' })
  expect(svg?.props.alt).toBe('5-hour limit 20% used, 7-day limit 58% used, context 100K of 1M, cache hit 90%')
  expect(svg?.props.isInteractive).toBeFalsy()
  expect(String(svg?.props.source)).toContain('<animate')
  expect(String(svg?.props.source).match(/class="sep"/g)?.length).toBe(3)
  expect(await desk.find({ type: 'Text' })).toBeUndefined()
  await desk.unmount()

  for (const surface of ['terminal'] as const) {
    const ui = await $.ui.mount({ plugin: 'usage-band-plus', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /^20%$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^58%$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '/1M' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '90%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '↑' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'not drawn' })).toBeUndefined()
    await ui.unmount()
  }
})

test('layout steps down to fit narrow terminals', async () => {
  const m = {
    context: { tokens: 130_000, window: 1_000_000, percent: 13 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 20, resetsAt: new Date(160 * 60_000).toISOString() },
      { kind: 'seven_day', percentUsed: 58, resetsAt: new Date(31 * 3_600_000).toISOString() },
    ],
  }
  const t = { input: 1_200, output: 3_000, cacheRead: 1_400_000, cacheWrite: 12_000 }
  expect(width(layout(m, t, 0, 0))).toBeLessThan(80)
})

test('the bar highlight moves left to right and keeps the bar width', async () => {
  const at = (f: number) => bar(50, 8, '#5cc4d6', f)
  const lum = (hex = '#000000') => [1, 3, 5].reduce((n, i) => n + parseInt(hex.slice(i, i + 2), 16), 0)
  // 50% of 8 cells fills 4; frames 4..12 put the glow past the fill, so frame 7 has none
  const plain = at(7).map(s => lum(s.color))
  // The glow sits one cell further right each frame
  const glowAt = (f: number) => {
    const lift = at(f).map((s, i) => lum(s.color) - plain[i]!)
    return lift.indexOf(Math.max(...lift))
  }
  expect(glowAt(0)).toBe(0)
  expect(glowAt(2)).toBe(2)
  expect(glowAt(3)).toBe(3)
  // Gradient: without a glow the bar brightens left to right
  expect(plain[0]! < plain[3]!).toBe(true)
  for (const f of [0, 3, 7, 20]) expect(width(at(f))).toBe(8)
})

test('auto picks Nerd Font icons only in Ghostty; a manual setting wins', async () => {
  expect(detectStyle('auto', 'ghostty')).toBe('nerd')
  expect(detectStyle('auto', 'Apple_Terminal')).toBe('unicode')
  expect(detectStyle('auto', 'WarpTerminal')).toBe('unicode')
  expect(detectStyle('auto', undefined)).toBe('unicode')
  expect(detectStyle('nerd', 'Apple_Terminal')).toBe('nerd')
  expect(detectStyle('ascii', 'ghostty')).toBe('ascii')
})

test('256-color preview snaps colors to the xterm palette', async () => {
  expect(to256('#000000')).toBe('#000000')
  expect(to256('#ffffff')).toBe('#ffffff')
  expect(to256('#5cc4d6')).toBe('#5fd7d7')
})

test('preview command draws every terminal profile', async ($, on) => {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.run', () => ({ text: '' }))
  const ui = await $.ui.mount({
    plugin: 'usage-band-plus',
    surface: 'terminal',
    component: 'CommandOutput',
    props: { command: 'usage-band-plus-preview', args: '', text: '' },
  } as never)
  expect(await ui.find({ type: 'Text', text: 'Ghostty' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'ascii fallback' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'hit ' })).toBeDefined()
  await ui.unmount()
})

test('bars of different fill keep their highlights in step', async () => {
  const lum = (hex = '#000000') => [1, 3, 5].reduce((n, i) => n + parseInt(hex.slice(i, i + 2), 16), 0)
  const glowAt = (pct: number, f: number) => {
    const plain = bar(pct, 8, '#5cc4d6', 12).map(s => lum(s.color))
    const lift = bar(pct, 8, '#5cc4d6', f).map((s, i) => lum(s.color) - plain[i]!)
    return lift.indexOf(Math.max(...lift))
  }
  for (const f of [0, 1, 2, 3, 13, 15]) expect(glowAt(50, f)).toBe(glowAt(90, f))
})

test('desktop context is a 2×10 dot matrix, top row first', async () => {
  const svgFor = (pct: number) =>
    desktopSvg({ context: { tokens: pct * 10_000, window: 1_000_000, percent: pct }, rateLimits: [] }, null, 0).svg
  const lit = (svg: string) => (svg.match(/<clipPath id="c-ctx">(.*?)<\/clipPath>/)?.[1]?.match(/<circle/g) ?? []).length
  const all = (svg: string) => (svg.match(/<circle [^>]*r="1.6"/g) ?? []).length
  expect(all(svgFor(35))).toBe(20 + 7)
  expect(lit(svgFor(35))).toBe(7)
  expect(lit(svgFor(0))).toBe(0)
  expect(lit(svgFor(100))).toBe(20)
  // 60% fills the whole top row and two dots of the bottom one
  const rows = (svgFor(60).match(/<clipPath id="c-ctx">(.*?)<\/clipPath>/)?.[1] ?? '').match(/cy="[\d.]+"/g) ?? []
  expect(rows.filter(r => r === 'cy="11.35"').length).toBe(10)
  expect(rows.filter(r => r === 'cy="18.15"').length).toBe(2)
})

test('the terminal bar animates once the band is drawn', async ($, on) => {
  const clock = mock.clock(on)
  on('session.measure', ($, e) => ({ changed: e.changed }))
  await $.session.measure({
    context: { tokens: 100_000, window: 1_000_000, percent: 10 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 50 }],
    changed: ['context', 'rateLimits'],
  })
  const ui = await $.ui.mount({ plugin: 'usage-band-plus', surface: 'terminal', ...BAND })
  const firstCell = async () => (await ui.find({ type: 'Text', text: '■' }))?.props.color
  const before = await firstCell()
  await clock.advance(200)
  expect(await firstCell()).not.toBe(before)
  await ui.unmount()
})

test('the desktop SVG declares both color schemes so a dark app gets no white backdrop', async () => {
  const { svg } = desktopSvg({ context: { tokens: 1, window: 10, percent: 10 }, rateLimits: [] }, null, 0)
  expect(svg).toContain('color-scheme:light dark')
  expect(svg).toContain('prefers-color-scheme:dark')
})


test('a redraw that changes nothing visible is not written', async ($, on) => {
  const at = Date.parse('2026-10-03T12:00:00Z')
  const m: Measure = {
    context: { tokens: 100_000, window: 1_000_000, percent: 10 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 20, resetsAt: new Date(at + 3 * 3_600_000 + 30 * 60_000).toISOString() }],
  }
  // 3h30m and 3h30m less 20 seconds both read 3h30m; 100,040 tokens still reads 100K
  expect(desktopSvg(m, null, at).svg).toBe(desktopSvg(m, null, at + 20_000).svg)
  expect(desktopSvg(m, null, at).svg).toBe(
    desktopSvg({ ...m, context: { ...m.context, tokens: 100_040 } }, null, at).svg,
  )
})

// ---- The info row

const STATUS = [
  '# branch.oid 60cd6091c0ffee0000000000000000000000beef',
  '# branch.head main',
  '# branch.upstream origin/main',
  '# branch.ab +1 -2',
  '1 .M N... 100644 100644 100644 aaa bbb README.md',
  '1 M. N... 100644 100644 100644 aaa bbb src/a.ts',
  '1 MM N... 100644 100644 100644 aaa bbb src/b.ts',
  '2 R. N... 100644 100644 100644 aaa bbb R100 new.ts\told.ts',
  'u UU N... 100644 100644 100644 100644 aaa bbb ccc clash.ts',
  '? notes.txt',
  '? scratch/',
  '! ignored.log',
  '',
].join('\n')

test('model ids read as names; names are kept', async () => {
  expect(fmtModel('claude-opus-5-5')).toBe('Opus 5.5')
  expect(fmtModel('claude-fable-5-2[1m]')).toBe('Fable 5.2 1M')
  expect(fmtModel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
  expect(fmtModel('claude-sonnet-5')).toBe('Sonnet 5')
  expect(fmtModel('Fable 5.2')).toBe('Fable 5.2')
})

test('git status is read from porcelain v2', async () => {
  expect(parseGitStatus(STATUS)).toEqual({
    branch: 'main',
    modified: 2,
    staged: 3,
    untracked: 2,
    conflicts: 1,
    ahead: 1,
    behind: 2,
  })
  // Clean, no upstream
  expect(parseGitStatus('# branch.oid abc1234def\n# branch.head dev\n')).toEqual({
    branch: 'dev',
    modified: 0,
    staged: 0,
    untracked: 0,
    conflicts: 0,
    ahead: 0,
    behind: 0,
  })
  // A detached head shows its short commit; a repository with no commit yet has none
  expect(parseGitStatus('# branch.oid 60cd6091c0ffee\n# branch.head (detached)\n').branch).toBe('60cd609')
  expect(parseGitStatus('# branch.oid (initial)\n# branch.head (detached)\n').branch).toBe('detached')
})

test('todo calls build the list: TodoWrite replaces, TaskCreate adds, TaskUpdate changes or removes', async () => {
  const written = applyTodoCall([], 'TodoWrite', {}, {
    newTodos: [
      { content: 'One', status: 'completed', activeForm: 'Doing one' },
      { content: 'Two', status: 'in_progress', activeForm: 'Doing two' },
    ],
  })
  expect(written).toEqual([
    { id: '0', subject: 'One', status: 'completed' },
    { id: '1', subject: 'Two', status: 'in_progress' },
  ])

  let list: Todo[] = applyTodoCall([], 'TaskCreate', { subject: 'Fix bug' }, { task: { id: '1', subject: 'Fix bug' } })
  list = applyTodoCall(list, 'TaskCreate', { subject: 'Test' }, { task: { id: '2', subject: 'Test' } })
  expect(list.map(t => t.status)).toEqual(['pending', 'pending'])
  list = applyTodoCall(list, 'TaskUpdate', { taskId: '1', status: 'in_progress' }, { success: true, taskId: '1' })
  expect(list[0]).toEqual({ id: '1', subject: 'Fix bug', status: 'in_progress' })
  // A call that failed changes nothing
  expect(applyTodoCall(list, 'TaskUpdate', { taskId: '2', status: 'completed' }, { success: false, taskId: '2' })).toEqual(list)
  list = applyTodoCall(list, 'TaskUpdate', { taskId: '2', subject: 'Run tests' }, { success: true, taskId: '2' })
  expect(list[1]).toEqual({ id: '2', subject: 'Run tests', status: 'pending' })
  // A task made before the mod loaded joins the list when it is first updated
  list = applyTodoCall(list, 'TaskUpdate', { taskId: '9', status: 'completed' }, { success: true, taskId: '9' })
  expect(list[2]).toEqual({ id: '9', subject: '#9', status: 'completed' })
  list = applyTodoCall(list, 'TaskUpdate', { taskId: '1', status: 'deleted' }, { success: true, taskId: '1' })
  expect(list.map(t => t.id)).toEqual(['2', '9'])
})

const GIT: Git = { branch: 'main', modified: 2, staged: 1, untracked: 3, conflicts: 0, ahead: 1, behind: 0 }
const TODOS: Todo[] = [
  { id: '1', subject: 'Read the code', status: 'completed' },
  { id: '2', subject: 'Fix the bug', status: 'in_progress' },
  { id: '3', subject: 'Run the tests', status: 'pending' },
]

test('the info row shows model, effort, git and the todo in progress', async () => {
  const info = { model: 'claude-opus-5-5', effort: 'high' }
  expect(infoText(info, GIT, TODOS)).toBe('Opus 5.5 · high  git:(main* !2 +1 ?3 ↑1)  ▸ Fix the bug (1/3)')
  // Clean and level with its upstream: the branch alone
  expect(infoText(info, { ...GIT, modified: 0, staged: 0, untracked: 0, ahead: 0 }, [])).toBe('Opus 5.5 · high  git:(main)')
  // Nothing in progress: the count; all done: a tick
  const idle = TODOS.map(t => (t.status === 'in_progress' ? { ...t, status: 'pending' as const } : t))
  expect(infoText({ model: null, effort: null }, null, idle)).toBe('1/3 todos')
  expect(infoText({ model: null, effort: null }, null, TODOS.map(t => ({ ...t, status: 'completed' as const })))).toBe('✓ 3/3')
  // No effort without a model to sit beside; nothing at all gives an empty row
  expect(infoText({ model: null, effort: 'high' }, null, [])).toBe('')
  // A long subject is cut
  const long = [{ id: '1', subject: 'x'.repeat(60), status: 'in_progress' as const }]
  expect(infoText(info, null, long)).toBe(`Opus 5.5 · high  ▸ ${'x'.repeat(39)}… (0/1)`)
  // ascii keeps to ASCII but for the middle dot the usage row also uses
  expect(infoText(info, GIT, TODOS)).toContain('↑')
  const ascii = infoLayout(info, { ...GIT, behind: 2 }, TODOS, 0, { style: 'ascii', colors: '256' })
  expect(ascii.map(s => s.text).join('')).toBe('Opus 5.5 · high  git:(main* !2 +1 ?3 ^1 v2)  > Fix the bug (1/3)')
})

test('the info row drops detail to fit: todo subject, ahead/behind, file counts, then effort', async () => {
  const info = { model: 'claude-opus-5-5', effort: 'high' }
  const look = { style: 'unicode', colors: 'true' } as const
  const at = (cols: number) =>
    fitInfo(info, GIT, TODOS, cols, look)
      .map(s => s.text)
      .join('')
  expect(at(120)).toBe('Opus 5.5 · high  git:(main* !2 +1 ?3 ↑1)  ▸ Fix the bug (1/3)')
  expect(at(50)).toBe('Opus 5.5 · high  git:(main* !2 +1 ?3 ↑1)  ▸ (1/3)')
  expect(at(47)).toBe('Opus 5.5 · high  git:(main* !2 +1 ?3)  ▸ (1/3)')
  expect(at(40)).toBe('Opus 5.5 · high  git:(main*)  ▸ (1/3)')
  expect(at(34)).toBe('Opus 5.5  git:(main*)  ▸ (1/3)')
  for (const cols of [120, 50, 47, 40, 34]) expect(width(fitInfo(info, GIT, TODOS, cols, look))).toBeLessThanOrEqual(cols)
})

test('a session fills the info row: model and effort, git on a timer, todos from tool calls', async ($, on) => {
  const clock = mock.clock(on)
  let status = STATUS
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  mock.env(on, {})
  mock.store(on)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { context: { tokens: 1_000, window: 1_000_000, percent: 0 }, rateLimits: [] } }) as never)
  on('settings.read', () => ({ value: { effortLevel: 'high' } }) as never)
  on('command.register', () => ({ value: { command: 'usage-band-plus-preview' } }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: status, stderr: '' } }) as never)
  on('tool.call', ($, e) =>
    e.tool === 'TaskCreate'
      ? { result: { task: { id: '7', subject: 'Fix the bug' } } }
      : e.tool === 'TaskUpdate'
        ? { result: { success: true, taskId: '7', updatedFields: ['status'] } }
        : { result: {} },
  )

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const text = async (surface: 'terminal' | 'desktop' | 'mobile' | 'vscode') => {
    const ui = await $.ui.mount({ plugin: 'usage-band-plus', surface, ...BAND })
    // Desktop and mobile draw the row as an image: its alt text carries the words
    const drawn = surface === 'desktop' || surface === 'mobile'
    const all = drawn
      ? String((await ui.findAll({ type: 'Svg' }))[0]?.props.alt)
      : (await ui.findAll({ type: 'Text' })).map(t => t.text).join('')
    await ui.unmount()
    return all
  }
  // Git waits for its timer
  expect(await text('terminal')).toContain('Opus 5.5 · high')
  expect(await text('terminal')).not.toContain('git:(')
  await clock.advance(500)
  expect(await text('terminal')).toContain('git:(main* ✗1 !2 +3 ?2 ↑1 ↓2)')

  await $.tool.call({ tool: 'TaskCreate', subject: 'Fix the bug', description: 'It is broken' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '7', status: 'in_progress' })
  expect(await text('terminal')).toContain('▸ Fix the bug (0/1)')
  // The desktop draws the same row as an image over the usage row
  expect(await text('desktop')).toBe('Opus 5.5 · high  git:(main* ✗1 !2 +3 ?2 ↑1 ↓2)  ▸ Fix the bug (0/1)')

  expect(await text('mobile')).toBe(await text('desktop'))
  expect(await text('vscode')).toContain('▸ Fix the bug (0/1)')

  // Each main-loop request brings its own model and effort; a subagent's does not
  const step = async (input: { model: string; effort?: 'low'; agentId?: string }) => {
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, messageCount: 1, ...input })) void _
  }
  await step({ model: 'claude-haiku-5-5', effort: 'low', agentId: 'a1' })
  expect(await text('terminal')).toContain('Opus 5.5 · high')
  await step({ model: 'claude-sonnet-5-5', effort: 'low' })
  expect(await text('terminal')).toContain('Sonnet 5.5 · low')
  // A model that takes no effort shows none
  await step({ model: 'claude-haiku-5-5' })
  expect(await text('terminal')).toContain('Haiku 5.5  git:(')

  // With room for a single row, the usage row is the one kept
  const one = await $.ui.mount({ plugin: 'usage-band-plus', surface: 'terminal', ...BAND, props: { ...(BAND.props as object), maxRows: 1 } as never })
  expect(await one.find({ type: 'Text', text: '/1M' })).toBeDefined()
  expect(await one.find({ type: 'Text', text: /git/ })).toBeUndefined()
  await one.unmount()

  // The desktop image's alt text says the row too
  const desk = await $.ui.mount({ plugin: 'usage-band-plus', surface: 'desktop', ...BAND })
  expect((await desk.findAll({ type: 'Svg' }))[1]?.props.alt).toBe(
    'model Haiku 5.5, git branch main: 1 in conflict, 2 modified, 3 staged, 2 untracked, 1 ahead, 2 behind, 0 of 1 todos done, now: Fix the bug, context 1K of 1M',
  )
  await desk.unmount()

  // A tool that can change the tree asks git again, once the timer runs
  status = '# branch.oid abc1234\n# branch.head main\n'
  await $.tool.call({ tool: 'Bash', command: 'git commit -am x' })
  await clock.advance(500)
  expect(await text('terminal')).toContain('git:(main)')
})

test('outside a repository, or without git, the band has no git group', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  mock.store(on)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.model', () => ({ value: 'Fable 5.2' }))
  on('session.usage', () => ({ value: { context: { tokens: 1_000, window: 1_000_000, percent: 0 }, rateLimits: [] } }) as never)
  on('command.register', () => ({ value: { command: 'usage-band-plus-preview' } }))
  on('settings.read', () => ({ value: {} }) as never)
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' } }) as never)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(500)
  const ui = await $.ui.mount({ plugin: 'usage-band-plus', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: 'Fable 5.2' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /git/ })).toBeUndefined()
  await ui.unmount()
})

test('todo calls made together are all counted', async ($, on) => {
  let made = 0
  on('tool.call', async () => {
    const id = String(++made)
    // Answer out of order, as tools running side by side do
    for (let wait = 10 * (4 - made); wait > 0; wait--) await Promise.resolve()
    return { result: { task: { id, subject: `Task ${id}` } } }
  })
  await Promise.all(
    ['a', 'b', 'c'].map(s => $.tool.call({ tool: 'TaskCreate', subject: s, description: s })),
  )
  const ui = await $.ui.mount({ plugin: 'usage-band-plus', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: '0/3 todos' })).toBeDefined()
  await ui.unmount()
})

test('the effort saved for a model wins over the session-wide one', async ($, on) => {
  const table = { 'claude-opus-5-5': { effortLevel: 'medium' }, 'claude-fable-5-2': { effortLevel: 'low' }, 'claude-haiku-5-5': {} }
  expect(modelEffort(table, 'claude-opus-5-5')).toBe('medium')
  // The model as `/model` may show it: with a variant, or by name
  expect(modelEffort(table, 'claude-fable-5-2[1m]')).toBe('low')
  expect(modelEffort(table, 'Fable 5.2')).toBe('low')
  expect(modelEffort(table, 'claude-haiku-5-5')).toBe(null)
  expect(modelEffort(table, 'claude-sonnet-5-5')).toBe(null)
  expect(modelEffort(undefined, 'claude-opus-5-5')).toBe(null)

  mock.clock(on)
  mock.env(on, {})
  mock.store(on)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.model', () => ({ value: 'claude-fable-5-2' }))
  on('session.usage', () => ({ value: { context: { tokens: 1_000, window: 1_000_000, percent: 0 }, rateLimits: [] } }) as never)
  on('settings.read', () => ({ value: { effortLevel: 'high', modelSettings: table } }) as never)
  on('command.register', () => ({ value: { command: 'usage-band-plus-preview' } }))
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: '' } }) as never)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'usage-band-plus', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: ' · low' })).toBeDefined()
  await ui.unmount()
})

test('the desktop info row keeps each part in its color, in both color schemes', async () => {
  const { svg, width, height, alt } = infoSvg({ model: 'claude-opus-5-5', effort: 'high' }, GIT, TODOS)
  expect(alt).toBe('Opus 5.5 · high  git:(main* !2 +1 ?3 ↑1)  ▸ Fix the bug (1/3)')
  // Model and branch, the git frame, the counts and the todo: each tinted for light and for dark
  expect(svg).toContain('<tspan class="ink" style="--l:#397a85;--d:#85d3e0">Opus 5.5</tspan>')
  expect(svg.match(/class="ink"/g)?.length).toBe(6)
  // Effort and the todo count stay quiet
  expect(svg).toContain('<tspan class="mute"> · high</tspan>')
  expect(svg).toContain('<tspan class="mute">(1/3)</tspan>')
  expect(svg).toContain('prefers-color-scheme:dark')
  expect(svg).toContain('xml:space="preserve"')
  expect(svg).not.toContain('<animate')
  expect(height).toBe(20)
  expect(width).toBeGreaterThan(300)
  // What is drawn is escaped
  expect(infoSvg({ model: null, effort: null }, { ...GIT, branch: 'a<b&c' }, []).svg).toContain('a&lt;b&amp;c*')
})
