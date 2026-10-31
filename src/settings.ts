import type {
  CustomFieldDef,
  PriorityConfig,
  StatusConfig,
  ViewMode
} from './types'
import type { TaskIdentification } from './store/TaskStore'
import type { ConflictPolicy, SyncDirection } from './github/sync'
import { DEFAULT_SYNC_CONFIG, type GitHubSyncConfig } from './github/mapping'

export interface TruelineSettings {
  identification: TaskIdentification
  tasksFolder: string
  projectsFolder: string
  /** Open a task in a modal, or as its own note in a tab. */
  openTasksIn: 'modal' | 'tab'
  defaultView: ViewMode
  statuses: StatusConfig[]
  priorities: PriorityConfig[]
  fields: CustomFieldDef[]
  teamMembers: string[]
  autoSchedule: boolean
  pullForwardOnEarlyFinish: boolean
  autoArchiveDays: number
  github: GitHubSettings
}

export interface GitHubSettings {
  enabled: boolean
  /**
   * Stored in data.json, which is a plain-text file inside the vault. If the vault is
   * synced or in git, the token goes with it. Use a fine-grained token scoped to the
   * repos below, never a classic token with broad scopes.
   */
  token: string
  repos: string[]
  /** 0 disables the timer; sync then only runs from the command. */
  pollSeconds: number
  direction: SyncDirection
  conflictPolicy: ConflictPolicy
  importNewIssues: boolean
  exportNewTasks: boolean
  syncOnStartup: boolean
  mapping: GitHubSyncConfig
}

export const DEFAULT_STATUSES: StatusConfig[] = [
  { id: 'open', label: 'Por hacer', color: '#8b8b8b', icon: 'circle', complete: false },
  { id: 'in-progress', label: 'En curso', color: '#3b82f6', icon: 'circle-dot', complete: false },
  { id: 'blocked', label: 'Bloqueada', color: '#ef4444', icon: 'circle-slash', complete: false },
  { id: 'in-review', label: 'En revisión', color: '#a855f7', icon: 'eye', complete: false },
  { id: 'done', label: 'Hecha', color: '#22c55e', icon: 'circle-check', complete: true },
  {
    id: 'cancelled',
    label: 'Cancelada',
    color: '#6b7280',
    icon: 'circle-x',
    complete: true,
    skipWhenCycling: true
  }
]

export const DEFAULT_PRIORITIES: PriorityConfig[] = [
  { id: 'critical', label: 'Crítica', color: '#dc2626', icon: 'chevrons-up', weight: 40 },
  { id: 'high', label: 'Alta', color: '#f97316', icon: 'chevron-up', weight: 30 },
  { id: 'medium', label: 'Media', color: '#eab308', icon: 'equal', weight: 20 },
  { id: 'low', label: 'Baja', color: '#64748b', icon: 'chevron-down', weight: 10 }
]

export const DEFAULT_SETTINGS: TruelineSettings = {
  // Property mode by default: it is the only identification both TaskNotes and
  // Project Manager can be pointed at, so one vault serves all three plugins.
  identification: { mode: 'property', key: 'tl-task', value: 'true' },
  tasksFolder: 'Proyectos/Tareas',
  projectsFolder: 'Proyectos',
  openTasksIn: 'tab',
  defaultView: 'table',
  statuses: DEFAULT_STATUSES,
  priorities: DEFAULT_PRIORITIES,
  fields: [],
  teamMembers: [],
  autoSchedule: true,
  pullForwardOnEarlyFinish: false,
  autoArchiveDays: 0,
  github: {
    enabled: false,
    token: '',
    repos: [],
    pollSeconds: 60,
    direction: 'both',
    conflictPolicy: 'manual',
    importNewIssues: true,
    exportNewTasks: false,
    syncOnStartup: true,
    mapping: DEFAULT_SYNC_CONFIG
  }
}

export function statusConfig(
  statuses: StatusConfig[],
  id: string
): StatusConfig | undefined {
  return statuses.find((s) => s.id === id)
}

export function isCompleteStatus(statuses: StatusConfig[], id: string): boolean {
  return statusConfig(statuses, id)?.complete ?? false
}

/** Click-to-cycle order, skipping the statuses configured out of it. */
export function nextStatus(statuses: StatusConfig[], current: string): string {
  const cycle = statuses.filter((s) => !s.skipWhenCycling)
  if (cycle.length === 0) return current
  const index = cycle.findIndex((s) => s.id === current)
  const next = cycle[(index + 1) % cycle.length]
  return next?.id ?? current
}
