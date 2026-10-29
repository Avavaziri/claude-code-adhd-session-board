import type { Card, CardStatus, GitWork, Project, Summary } from '../types'

export type SessionRow = {
  sessionId: string
  title: string
  cwd: string
  branch?: string
  isArchived: boolean
  isRunning: boolean
  prNumber?: number
  prState?: string
  lastActivityAt: string
  group?: { id: string; name: string } | null
}

const GROUP = 'group:'
const WORKTREE = /[\\/]\.claude[\\/]worktrees[\\/]/i
const IDLE_DAYS = 7

export function projectRoot(cwd: string): string {
  return cwd.split(WORKTREE)[0]!.replace(/[\\/]+$/, '')
}

export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

export function isWorktree(cwd: string): boolean {
  return WORKTREE.test(cwd)
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

export function isGroup(project: string): boolean {
  return project.startsWith(GROUP)
}

export function groupProject(id: string): string {
  return GROUP + id
}

export function inProject(row: SessionRow, project: string): boolean {
  if (isGroup(project)) return row.group?.id === project.slice(GROUP.length)
  return samePath(projectRoot(row.cwd), project)
}

export function listProjects(rows: readonly SessionRow[]): Project[] {
  const seen = new Map<string, Project>()
  for (const row of rows) {
    if (row.isArchived || !row.group) continue
    const root = groupProject(row.group.id)
    if (!seen.has(root)) seen.set(root, { root, name: row.group.name })
  }
  for (const row of rows) {
    if (row.isArchived || /[\\/]scratch-workspaces[\\/]/i.test(row.cwd)) continue
    const root = projectRoot(row.cwd)
    const key = root.toLowerCase()
    if (!seen.has(key)) seen.set(key, { root, name: baseName(root) })
  }
  return [...seen.values()]
}

export function summaryKey(row: SessionRow): string {
  return `v2|${row.lastActivityAt}|${row.isRunning}`
}

export function isUnmerged(row: SessionRow, git: GitWork | undefined): boolean {
  if (row.prState === 'OPEN' || row.prState === 'DRAFT') return true
  if (!git) return false
  // A squash merge leaves the branch's own commits outside the base.
  const notMerged = row.prState === 'MERGED' ? 0 : git.notInBase
  return git.uncommitted > 0 || notMerged > 0
}

export function statusOf(
  row: SessionRow,
  git: GitWork | undefined,
  summary: Summary | undefined,
  now: number,
): CardStatus {
  if (row.isRunning) return 'working'
  if (summary?.needsYou) return 'needs-you'
  if (isUnmerged(row, git)) return 'unmerged'
  if (row.prState === 'MERGED' || row.prState === 'CLOSED') return 'done'
  const ageDays = (now - Date.parse(row.lastActivityAt)) / 86_400_000
  return ageDays > IDLE_DAYS ? 'done' : 'idle'
}

const ORDER: Record<CardStatus, number> = {
  'needs-you': 0,
  unmerged: 1,
  working: 2,
  idle: 3,
  done: 4,
}

export function sortCards(cards: readonly Card[]): Card[] {
  return [...cards].sort(
    (a, b) =>
      ORDER[a.status] - ORDER[b.status] ||
      Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt),
  )
}

export function lastTurns(transcript: string, maxChars = 6000): string {
  const start = transcript.search(/^\[(assistant|user)\]/m)
  const body = start < 0 ? transcript : transcript.slice(start)
  return body.slice(-maxChars)
}

export function parseSummary(text: string, key: string): Summary | undefined {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return undefined
  try {
    const raw = JSON.parse(match[0]) as Record<string, unknown>
    const doing = typeof raw.doing === 'string' ? raw.doing.trim() : ''
    const waiting = typeof raw.waitingOn === 'string' ? raw.waitingOn.trim() : ''
    if (!doing) return undefined
    const needsYou = raw.needsYou === true
    const question = needsYou && typeof raw.question === 'string' ? raw.question.trim() : ''
    const answers = Array.isArray(raw.answers)
      ? raw.answers
          .filter((a): a is string => typeof a === 'string' && a.trim().length > 0 && a.length <= 40)
          .map(a => a.trim())
          .slice(0, 3)
      : []
    return {
      key,
      doing,
      waitingOn: waiting && waiting.toLowerCase() !== 'null' ? waiting : null,
      needsYou,
      question: question || null,
      answers: needsYou ? answers : [],
    }
  } catch {
    return undefined
  }
}

export function factsLine(card: Card, now: number): string {
  const facts: string[] = []
  if (card.branch) facts.push(card.branch)
  if (card.prNumber) facts.push(`PR #${card.prNumber} ${(card.prState ?? '').toLowerCase()}`)
  const git = card.git
  if (git) {
    if (git.uncommitted) facts.push(`${git.uncommitted} files not committed`)
    if (git.notInBase && card.prState !== 'MERGED')
      facts.push(`${git.notInBase} commits not in ${git.base}`)
    if (git.unpushed) facts.push(`${git.unpushed} not pushed`)
  }
  facts.push(timeAgo(card.lastActivityAt, now))
  return facts.join(' · ')
}

export function timeAgo(iso: string, now: number): string {
  const mins = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

export type PeerMessage = { from?: string; fromName?: string; body: string }

export function parsePeerMessage(text: string): PeerMessage | undefined {
  const open = text.match(/<cross-session-message\b([^>]*)>/)
  if (!open) return undefined
  const attr = (name: string) => open[1]!.match(new RegExp(`${name}="([^"]*)"`))?.[1]
  const start = open.index! + open[0].length
  const end = text.indexOf('</cross-session-message>', start)
  const body = text.slice(start, end < 0 ? undefined : end).trim()
  return { from: attr('from'), fromName: attr('from-name'), body }
}

export const SINCE_ALL = 'all'
export const SINCE_DAYS = 7

const DAY_MS = 86_400_000

export function startOfDay(now: number, daysBack: number): number {
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  return day.getTime() - daysBack * DAY_MS
}

export function sinceStart(since: string, now: number): number | undefined {
  if (since === SINCE_ALL) return undefined
  const days = Number(since)
  return Number.isInteger(days) && days >= 0 ? startOfDay(now, days) : startOfDay(now, 0)
}

export function sinceOptions(now: number): { value: string; label: string }[] {
  const options = [...Array(SINCE_DAYS).keys()].map(days => {
    const label =
      days === 0
        ? 'Today'
        : days === 1
          ? 'Since yesterday'
          : `Since ${new Date(startOfDay(now, days)).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}`
    return { value: String(days), label }
  })
  return [...options, { value: SINCE_ALL, label: 'All dates' }]
}

export function isInRange(row: SessionRow, start: number | undefined): boolean {
  return start === undefined || row.isRunning || Date.parse(row.lastActivityAt) >= start
}
