import { expect, mock, test } from 'claude-code/testing'

const ROOT = 'C:\\dev\\app'
const NOW = Date.parse('2026-10-29T12:00:00Z')

const SESSIONS = [
  {
    sessionId: 'local_a',
    title: 'Calendar booking',
    cwd: `${ROOT}\\.claude\\worktrees\\cal`,
    branch: 'feature/cal',
    isArchived: false,
    isRunning: false,
    prNumber: 12,
    prState: 'OPEN',
    lastActivityAt: '2026-10-29T11:50:00Z',
  },
  {
    sessionId: 'local_b',
    title: 'Old fix',
    cwd: ROOT,
    isArchived: false,
    isRunning: false,
    prNumber: 9,
    prState: 'MERGED',
    lastActivityAt: '2026-10-28T11:00:00Z',
  },
  {
    sessionId: 'local_c',
    title: 'Other project',
    cwd: 'C:\\dev\\other',
    isArchived: false,
    isRunning: true,
    lastActivityAt: '2026-10-29T11:59:00Z',
  },
]

const PANE = {
  plugin: 'session-board',
  component: 'Pane',
  requestId: 'session-board',
  props: {
    title: 'Session board',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('cards show the project sessions in progress, done ones hidden', async ($, on) => {
  const sent: unknown[] = []
  mock.store(on)
  on('command.register', () => ({ value: { command: 'board' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('mcp.call', (_, e) => {
    if (e.tool === 'send_message') sent.push(e.args)
    const text =
      e.tool === 'list_sessions'
        ? JSON.stringify(SESSIONS)
        : e.tool === 'list_events'
          ? 'Session "x" (idle)\n\n[assistant] PR is open. CI is still running. Merge it?'
          : 'delivered'
    return { value: { content: [{ type: 'text', text }], isError: false } }
  })
  on('process.run', (_, e) => {
    const args = e.argv.join(' ')
    const stdout = args.includes('rev-parse')
      ? 'v2'
      : args.includes('status')
        ? args.includes('worktrees')
          ? ' M a.ts\n M b.ts'
          : ''
        : '3'
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('model.complete', () => ({
    value: {
      isAnswered: true,
      text: '{"doing": "Opened PR for calendar booking", "waitingOn": "CI to pass", "needsYou": true}',
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  }))

  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'board', args: '' })

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'refresh' })
    expect((await ui.find({ type: 'Text', text: /Calendar booking/ }))).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /Needs you/ }))).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /Waiting on: CI to pass/ }))).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /2 files not committed · 3 commits not in v2/ }))).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Old fix/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Other project/ })).toBeUndefined()

    if (surface === 'desktop') {
      await ui.press({ key: 'ask-local_a' })
      expect(sent.length).toBe(1)
      await ui.press({ key: 'toggle-done' })
      expect(await ui.find({ type: 'Text', text: /Old fix/ })).toBeDefined()
      await ui.press({ key: 'toggle-done' })
    }
    await ui.unmount()
  }
})
