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
}

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

export function listProjects(rows: readonly SessionRow[]): Project[] {
  const seen = new Map<string, Project>()
  for (const row of rows) {
    if (row.isArchived || /[\\/]scratch-workspaces[\\/]/i.test(row.cwd)) continue
    const root = projectRoot(row.cwd)
    const key = root.toLowerCase()
    if (!seen.has(key)) seen.set(key, { root, name: baseName(root) })
  }
  return [...seen.values()]
}

export function summaryKey(row: SessionRow): string {
  return `${row.lastActivityAt}|${row.isRunning}`
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
    return {
      key,
      doing,
      waitingOn: waiting && waiting.toLowerCase() !== 'null' ? waiting : null,
      needsYou: raw.needsYou === true,
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
