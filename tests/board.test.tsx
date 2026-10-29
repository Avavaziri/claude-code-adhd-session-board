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
  {
    sessionId: 'local_d',
    title: 'Board work',
    cwd: 'C:\\Users\\me\\AppData\\Roaming\\Claude\\scratch-workspaces\\x',
    isArchived: false,
    isRunning: true,
    lastActivityAt: '2026-10-29T11:58:00Z',
    group: { id: 'cg-board', name: 'Session board' },
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
      text: '{"doing": "Opened PR for calendar booking", "waitingOn": "CI to pass", "needsYou": true, "question": "Merge PR 12 once CI passes?", "answers": ["Yes, merge it", "Not now"]}',
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  }))
  on('clock.after', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.receive', (_, e) => ({ text: e.text }))

  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'board', args: '' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ type: 'Text', text: /Calendar booking/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Needs you/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Asks: Merge PR 12 once CI passes\?/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /2 files not committed · 3 commits not in v2/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Old fix/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Other project/ })).toBeUndefined()
    expect(await ui.find({ key: 'answer-local_a-0' })).toBeDefined()

    if (surface === 'desktop') {
      await ui.press({ key: 'ask-local_a' })
      expect(sent.length).toBe(1)
      expect(await ui.find({ type: 'Text', text: /waiting for its reply/ })).toBeDefined()

      const reply = await $.session.receive({
        origin: { kind: 'peer-send-message' },
        text: '<cross-session-message from="local_a" from-name="Calendar booking">\nDoing: waiting on CI.\n</cross-session-message>',
      })
      expect(reply.consumed).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Doing: waiting on CI/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /waiting for its reply/ })).toBeUndefined()

      const other = await $.session.receive({
        origin: { kind: 'peer-send-message' },
        text: '<cross-session-message from="local_c" from-name="Other project">hello</cross-session-message>',
      })
      expect(other.consumed).toBeUndefined()

      await ui.press({ key: 'answer-local_a-0' })
      expect(sent.length).toBe(2)
      expect(JSON.stringify(sent[1])).toContain('Their answer: Yes, merge it')
      expect(await ui.find({ type: 'Text', text: /You replied "Yes, merge it"/ })).toBeDefined()
      expect(await ui.find({ key: 'answer-local_a-0' })).toBeUndefined()

      expect(await ui.find({ type: 'Text', text: /1 older hidden/ })).toBeDefined()
      expect(await ui.find({ key: 'toggle-done' })).toBeUndefined()
    }
    await ui.unmount()
  }
})

test('a session in a sidebar group shows only that group', async ($, on) => {
  mock.store(on, { project: ROOT })
  on('command.register', () => ({ value: { command: 'board' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: 'C:\\Users\\me\\AppData\\Roaming\\Claude\\scratch-workspaces\\x' }))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('mcp.call', (_, e) => {
    const text =
      e.tool === 'list_sessions'
        ? JSON.stringify(SESSIONS)
        : e.tool === 'get_session'
          ? JSON.stringify(SESSIONS[3])
          : '[assistant] Building the board.'
    return { value: { content: [{ type: 'text', text }], isError: false } }
  })
  on('process.run', () => ({
    value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('model.complete', () => ({
    value: {
      isAnswered: true,
      text: '{"doing": "Building the board", "waitingOn": null, "needsYou": false}',
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  }))
  on('clock.after', () => ({ value: undefined }))

  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: /Board work/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Calendar booking/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Other project/ })).toBeUndefined()
  await ui.unmount()

  for (const surface of ['desktop', 'mobile'] as const) {
    const view = await $.ui.mount({ ...PANE, surface })
    await view.press({ key: 'project-app' })
    expect(await view.find({ type: 'Text', text: /Calendar booking/ })).toBeDefined()
    await view.press({ key: 'project-Session board' })
    expect(await view.find({ type: 'Text', text: /Board work/ })).toBeDefined()
    expect(await view.find({ type: 'Text', text: /Calendar booking/ })).toBeUndefined()
    await view.unmount()
  }
})

test('choosing all dates brings older sessions back', async ($, on) => {
  const sent: unknown[] = []
  mock.store(on, { since: 'all' })
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
      text: '{"doing": "Opened PR for calendar booking", "waitingOn": "CI to pass", "needsYou": true, "question": "Merge PR 12 once CI passes?", "answers": ["Yes, merge it", "Not now"]}',
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  }))
  on('clock.after', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.receive', (_, e) => ({ text: e.text }))

  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: /older hidden/ })).toBeUndefined()
  await ui.press({ key: 'toggle-done' })
  expect(await ui.find({ type: 'Text', text: /Old fix/ })).toBeDefined()
  await ui.unmount()
})
