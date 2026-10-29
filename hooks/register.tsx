import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Board, Card, CardStatus, GitWork, Summary } from '../types'
import {
  baseName,
  factsLine,
  isWorktree,
  lastTurns,
  listProjects,
  parseSummary,
  projectRoot,
  samePath,
  sortCards,
  statusOf,
  summaryKey,
  timeAgo,
  type SessionRow,
} from './board'

const PANE = 'session-board'
const TITLE = 'Session board'
const SESSIONS = 'ccd_session_mgmt'
const EVERY_MS = 60_000

const board = atom({ plugin: 'session-board', key: 'board' } as const, { phase: 'loading', projects: [], cards: [] } as Board, {
  shape: 'board-1',
})
const asked = atom({ plugin: 'session-board', key: 'asked' } as const, {} as Record<string, number>, {
  shape: 'asked-1',
})
const showDone = { plugin: 'session-board', key: 'showDone' } as const

const SYSTEM = `You read the end of a Claude Code session transcript and report its status to the person managing it.
Reply with JSON only: {"doing": string, "waitingOn": string | null, "needsYou": boolean}
- doing: what the session did or is doing, at most 14 plain words.
- waitingOn: what it is blocked or delayed on (CI, a review, a merge, a decision), at most 14 words; null when nothing.
- needsYou: true only when its last message asks the person a question or needs their approval, decision or action.`

const ASK_TEXT =
  'Status check from the session board. Reply in three short lines: 1) what you are doing, 2) what you are waiting on (or "nothing"), 3) any unmerged work and why it is not merged yet.'

let busy = false

async function inBatches<T, R>(items: readonly T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))))
  return out
}

async function callTool($: EngineInterface, tool: string, args: Record<string, unknown>): Promise<string> {
  const result = await $.mcp.call(SESSIONS, tool, args)
  const text = result.content.map(block => block.text ?? '').join('\n')
  if (result.isError) throw new Error(text || `${tool} failed`)
  return text
}

async function git($: EngineInterface, cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const run = await $.process.run(['git', '-C', cwd, ...args], { timeoutMs: 15_000 })
    return run.exitCode === 0 ? run.stdout.trim() : undefined
  } catch {
    return undefined
  }
}

async function countRef($: EngineInterface, cwd: string, range: string): Promise<number | undefined> {
  const out = await git($, cwd, ['rev-list', '--count', range])
  return out === undefined ? undefined : Number(out) || 0
}

async function gitWork($: EngineInterface, cwd: string, base: string): Promise<GitWork | undefined> {
  const status = await git($, cwd, ['status', '--porcelain'])
  if (status === undefined) return undefined
  const notInBase =
    (await countRef($, cwd, `origin/${base}..HEAD`)) ?? (await countRef($, cwd, `${base}..HEAD`)) ?? 0
  const unpushed = (await countRef($, cwd, '@{u}..HEAD')) ?? notInBase
  return {
    uncommitted: status ? status.split('\n').length : 0,
    notInBase,
    unpushed,
    base,
  }
}

async function summarise($: EngineInterface, row: SessionRow): Promise<Summary | undefined> {
  const key = summaryKey(row)
  try {
    const transcript = await callTool($, 'list_events', { session_id: row.sessionId, limit: 4 })
    const reply = await $.model.complete({
      model: 'haiku',
      system: SYSTEM,
      prompt: `Session title: ${row.title}\n\n${lastTurns(transcript)}`,
      maxTokens: 200,
      timeoutMs: 30_000,
    })
    return reply.isAnswered ? parseSummary(reply.text, key) : undefined
  } catch {
    return undefined
  }
}

async function chooseProject($: EngineInterface, rows: SessionRow[]): Promise<string | undefined> {
  const projects = listProjects(rows)
  const stored = (await $.store.get('project')) as string | undefined
  if (stored && projects.some(p => samePath(p.root, stored))) return stored
  const own = projectRoot(await $.session.root())
  if (projects.some(p => samePath(p.root, own))) return own
  return projects[0]?.root
}

async function refresh($: EngineInterface): Promise<void> {
  if (busy) return
  busy = true
  try {
    const rows = JSON.parse(await callTool($, 'list_sessions', { limit: 80 })) as SessionRow[]
    const projects = listProjects(rows)
    const project = await chooseProject($, rows)
    const mine = project ? rows.filter(r => !r.isArchived && samePath(projectRoot(r.cwd), project)) : []
    const now = await $.clock.now()

    const branch = project ? ((await git($, project, ['rev-parse', '--abbrev-ref', 'HEAD'])) ?? 'main') : 'main'
    const rootStatus = project ? await git($, project, ['status', '--porcelain']) : undefined
    const checkout =
      rootStatus === undefined ? undefined : { branch, uncommitted: rootStatus ? rootStatus.split('\n').length : 0 }

    const cache = ((await $.store.get('summaries')) ?? {}) as Record<string, Summary>
    const cards: Card[] = await inBatches(mine, 4, async row => {
        const work = isWorktree(row.cwd) ? await gitWork($, row.cwd, branch) : undefined
        let summary: Summary | undefined = cache[row.sessionId]
        const preliminary = statusOf(row, work, summary, now)
        if (preliminary !== 'done' && summary?.key !== summaryKey(row)) {
          summary = (await summarise($, row)) ?? summary
          if (summary) cache[row.sessionId] = summary
        }
        const status: CardStatus = statusOf(row, work, summary, now)
        return {
          id: row.sessionId,
          title: row.title,
          isRunning: row.isRunning,
          lastActivityAt: row.lastActivityAt,
          branch: row.branch,
          prNumber: row.prNumber,
          prState: row.prState,
          git: work,
          doing: summary?.doing ?? 'No summary yet.',
          waitingOn: summary?.waitingOn ?? null,
          status,
        }
      })

    const live = new Set(rows.map(r => r.sessionId))
    await $.store.set('summaries', Object.fromEntries(Object.entries(cache).filter(([id]) => live.has(id))))
    await update($, board, (): Board => ({
      phase: 'ready',
      project,
      projects,
      cards: sortCards(cards),
      checkout,
      updatedAt: now,
    }))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await update($, board, (b): Board => ({ ...b, phase: 'error', error: message }))
  } finally {
    busy = false
  }
}

const LOOK: Record<CardStatus, { label: string; color: string }> = {
  'needs-you': { label: 'Needs you', color: 'warning' },
  unmerged: { label: 'Unmerged work', color: 'permission' },
  working: { label: 'Working', color: 'suggestion' },
  idle: { label: 'Idle', color: 'inactive' },
  done: { label: 'Done', color: 'success' },
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'board', description: 'Show the session board for this project' })
    void $.ui.open({ id: PANE, title: TITLE })
    void refresh($)
    $.clock.every(EVERY_MS, () => void refresh($))
    return next(e)
  })

  on('command.run', { command: 'board' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    void refresh($)
    return { text: 'Session board opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const Select = 'Select' in table ? table.Select : undefined
    const data = await read($, board)
    const askedAt = await read($, asked)
    const { value: isShowingDone = false } = await $.state.get(showDone)
    const now = await $.clock.now()
    const columns = e.props.bodyColumns ?? 60
    const perRow = columns >= 110 ? 2 : 1
    const cardWidth = Math.floor((columns - (perRow - 1) * 1) / perRow)

    const reload = () => {
      void update($, board, (b): Board => ({ ...b, phase: 'loading' }))
      void refresh($)
    }
    const pickProject = (root: string) => {
      void $.store.set('project', root).then(reload)
    }
    const askForUpdate = (card: Card) => {
      void callTool($, 'send_message', { session_id: card.id, message: ASK_TEXT })
        .then(() => update($, asked, map => ({ ...map, [card.id]: Date.now() })))
        .catch(err => $.ui.toast(`Could not ask ${card.title}: ${err instanceof Error ? err.message : err}`))
    }

    const doneCount = data.cards.filter(c => c.status === 'done').length
    const shown = data.cards.filter(c => isShowingDone || c.status !== 'done')
    const counts = (['needs-you', 'unmerged', 'working', 'idle'] as const)
      .map(s => [s, data.cards.filter(c => c.status === s).length] as const)
      .filter(([, n]) => n > 0)
      .map(([s, n]) => `${n} ${LOOK[s].label.toLowerCase()}`)
      .join(' · ')

    const header = (
      <Box flexDirection="column" gap={1} marginBottom={1}>
        <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
          {!Select || data.projects.length === 0 ? (
            <Text bold>{data.project ? baseName(data.project) : 'No project'}</Text>
          ) : (
            <Select
              key="project"
              label="Project"
              value={data.project}
              options={data.projects.map(p => ({ value: p.root, label: p.name }))}
              onSelect={value => pickProject(value)}
            />
          )}
          <Button key="refresh" onPress={reload}>
            Refresh
          </Button>
          {doneCount > 0 && (
            <Button key="toggle-done" onPress={() => void $.state.set(showDone, !isShowingDone)}>
              {isShowingDone ? 'Hide done' : `Show ${doneCount} done`}
            </Button>
          )}
        </Box>
        <Text dimColor>
          {data.phase === 'loading' ? 'Checking sessions…' : counts || 'Nothing in progress.'}
          {data.updatedAt ? ` · updated ${timeAgo(new Date(data.updatedAt).toISOString(), now)}` : ''}
        </Text>
        {data.checkout && data.checkout.uncommitted > 0 && (
          <Text color="warning">
            Main folder ({data.checkout.branch}) has {data.checkout.uncommitted} uncommitted files. Sessions working there
            share them.
          </Text>
        )}
      </Box>
    )
    if (data.phase === 'error') {
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          <Text color="warning">Could not read the session list.</Text>
          <Text dimColor>{data.error}</Text>
        </Box>
      )
    }

    if (data.phase === 'loading' && data.cards.length === 0) {
      return (
        <Box flexDirection="column">
          {header}
          <Text dimColor>Reading each session's latest update…</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {header}
        {shown.length === 0 && <Text dimColor>No sessions in progress on this project.</Text>}
        <Box flexDirection="row" flexWrap="wrap" columnGap={1} rowGap={1}>
          {shown.map(card => {
            const look = LOOK[card.status]
            const askTime = askedAt[card.id]
            return (
              <Box
                key={`card-${card.id}`}
                width={cardWidth}
                flexDirection="column"
                borderStyle="round"
                borderColor={look.color}
                paddingX={1}
              >
                <Box flexDirection="row" justifyContent="space-between" gap={1}>
                  <Text bold>{card.title}</Text>
                  <Text color={look.color}>{look.label}</Text>
                </Box>
                <Text>{card.doing}</Text>
                {card.waitingOn && <Text color="warning">Waiting on: {card.waitingOn}</Text>}
                <Text dimColor>{factsLine(card, now)}</Text>
                <Box flexDirection="row" gap={1} alignItems="center">
                  <Button key={`ask-${card.id}`} onPress={() => askForUpdate(card)}>
                    Ask for update
                  </Button>
                  {askTime && (
                    <Text dimColor>asked {timeAgo(new Date(askTime).toISOString(), now)}</Text>
                  )}
                </Box>
              </Box>
            )
          })}
        </Box>
      </Box>
    )
  })
}
