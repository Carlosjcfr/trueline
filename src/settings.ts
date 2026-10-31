import type {
  CustomFieldDef,
  PriorityConfig,
  StatusConfig,
  ViewMode
} from './types'
import type { TaskIdentification } from './store/TaskStore'
import type { ConflictPolicy, SyncDirection } from './github/sync'
import { DEFAULT_SYNC_CONFIG, type GitHubSyncConfig } from './github/mapping'

/**
 * Bump when a stored setting changes meaning or shape, and add the step to `migrate`.
 * Adding a new setting needs no bump: `loadSettings` fills it from the defaults.
 */
export const SETTINGS_VERSION = 1

export interface TruelineSettings {
  settingsVersion: number
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
  /**
   * Per-repo high-water mark: the `updated_at` of the last issue applied without error.
   * Persisted so a restart resumes where the last session stopped instead of asking
   * GitHub for every issue again.
   */
  lastPolled: Record<string, string>
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

/**
 * Read-only template. Never hand this object out: use `defaultSettings()`, which
 * returns a fresh copy. Handing it out is how editing a setting once silently changed
 * the defaults for the rest of the session.
 */
export const DEFAULT_SETTINGS: Readonly<TruelineSettings> = {
  settingsVersion: SETTINGS_VERSION,
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
    mapping: DEFAULT_SYNC_CONFIG,
    lastPolled: {}
  }
}

export function defaultSettings(): TruelineSettings {
  return structuredClone(DEFAULT_SETTINGS) as TruelineSettings
}

/**
 * Builds the live settings from whatever `loadData()` returned.
 *
 * `Object.assign({}, DEFAULT_SETTINGS, saved)` - what this replaced - only merges the
 * top level. A data.json written before `github.mapping` existed then replaced the
 * whole `github` object, leaving `mapping` undefined and the settings tab throwing a
 * TypeError on open. The rules here:
 *
 *  - start from a fresh copy of the defaults, so nothing the user edits can leak back
 *    into them;
 *  - merge plain objects key by key, at every depth;
 *  - take arrays and scalars from the saved data whole - a status list is replaced,
 *    never interleaved with the default one;
 *  - ignore a saved value whose type does not match the default, rather than letting
 *    one hand-edited typo take the plugin down;
 *  - keep saved keys the defaults do not know about, so a data.json written by a newer
 *    version survives a round trip through an older one.
 */
export function loadSettingsFrom(saved: unknown): TruelineSettings {
  const base = defaultSettings()
  if (!isPlainObject(saved)) return base
  const migrated = migrate(structuredClone(saved))
  const merged = mergeInto(base as unknown as Record<string, unknown>, migrated)
  merged.settingsVersion = SETTINGS_VERSION
  return merged as unknown as TruelineSettings
}

/**
 * One step per version. Each receives the data as the previous version wrote it.
 * Version 0 is everything saved before `settingsVersion` existed.
 */
function migrate(saved: Record<string, unknown>): Record<string, unknown> {
  const version = typeof saved.settingsVersion === 'number' ? saved.settingsVersion : 0

  if (version < 1) {
    // Before v1 an empty "expected value" was stored as undefined, which JSON drops,
    // so there is nothing to recover; from v1 it is stored as ''.
  }

  return saved
}

function mergeInto(
  base: Record<string, unknown>,
  saved: Record<string, unknown>
): Record<string, unknown> {
  for (const [key, value] of Object.entries(saved)) {
    if (!(key in base)) {
      base[key] = value
      continue
    }
    const current = base[key]
    if (isPlainObject(current) && isPlainObject(value)) {
      base[key] = mergeInto(current, value)
    } else if (sameKind(current, value)) {
      base[key] = value
    }
  }
  return base
}

function sameKind(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b)
  return typeof a === typeof b
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
