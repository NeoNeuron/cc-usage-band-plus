export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Measure = {
  context: { tokens?: number; window: number; percent?: number }
  rateLimits: Limit[]
}
export type TurnTokens = { input: number; output: number; cacheRead: number; cacheWrite: number }
export type Style = 'nerd' | 'unicode' | 'ascii'
export type Info = { model: string | null; effort: string | null }
export type Git = {
  branch: string
  modified: number
  staged: number
  untracked: number
  conflicts: number
  ahead: number
  behind: number
}
export type Todo = { id: string; subject: string; status: 'pending' | 'in_progress' | 'completed' }

declare module 'claude-code' {
  interface PluginState {
    'usage-band-plus': {
      measure: Measure | null
      turn: TurnTokens | null
      now: number
      phase: number
      style: Style
      info: Info
      git: Git | null
      todos: Todo[]
      session: string | null
    }
  }
}
