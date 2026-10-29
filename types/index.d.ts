export type CardStatus = 'needs-you' | 'working' | 'unmerged' | 'idle' | 'done'

export type GitWork = {
  uncommitted: number
  notInBase: number
  unpushed: number
  base: string
}

export type Summary = {
  key: string
  doing: string
  waitingOn: string | null
  needsYou: boolean
}

export type Card = {
  id: string
  title: string
  isRunning: boolean
  lastActivityAt: string
  branch?: string
  prNumber?: number
  prState?: string
  git?: GitWork
  doing: string
  waitingOn: string | null
  status: CardStatus
}

export type Project = { root: string; name: string }

export type Board = {
  phase: 'loading' | 'ready' | 'error'
  error?: string
  project?: string
  projects: Project[]
  cards: Card[]
  checkout?: { branch: string; uncommitted: number }
  updatedAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    'session-board': {
      board: Shaped<Board>
      showDone: boolean
      asked: Shaped<Record<string, number>>
    }
  }
}
