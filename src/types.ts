/**
 * Data model for ProjectNotes.
 *
 * The task shape follows the TaskNotes specification (semantic roles, §2), so any
 * other conforming tool can read and write the same files. Fields marked EXTENSION
 * are additive roles this plugin introduces; per §2.7 every reader must preserve
 * unknown frontmatter, so they cost nothing in interoperability.
 *
 * Spec: https://github.com/callumalpass/tasknotes-spec
 */

/** ISO date, `YYYY-MM-DD`. */
export type DateOnly = string
/** ISO date or date-time. §3 decides how a bare date is interpreted. */
export type DateOrDateTime = string
/** ISO 8601 duration, e.g. `P1D`, `-PT30M`. */
export type Duration = string

/** Status and priority values are open sets; the catalogs live in project config. */
export type StatusId = string
export type PriorityId = string

/** A reference to another note: `[[wikilink]]`, a vault path, or a stable id. §11. */
export type LinkRef = string

// ---------------------------------------------------------------------------
// Structured role schemas (§2.6)
// ---------------------------------------------------------------------------

/** §2.6.1. Canonical duration is derived from start/end and is never persisted. */
export interface TimeEntry {
  startTime: DateOrDateTime
  /** Absent means the session is still running. At most one per task at commit time. */
  endTime?: string
  description?: string
}

export type RelType = 'FINISHTOSTART' | 'FINISHTOFINISH' | 'STARTTOSTART' | 'STARTTOFINISH'

/** §2.6.3. `gap` is the lag the Gantt renders between the two bars. */
export interface Dependency {
  uid: LinkRef
  reltype: RelType
  gap?: Duration
}

/** §2.6.4. */
export type Reminder =
  | {
      id: string
      type: 'relative'
      relatedTo: 'due' | 'scheduled'
      offset: Duration
      description?: string
    }
  | {
      id: string
      type: 'absolute'
      absoluteTime: DateOrDateTime
      description?: string
    }

export type RecurrenceAnchor = 'scheduled' | 'completion'

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

/**
 * A task as the rest of the plugin sees it. Every field maps to a semantic role;
 * `unknown` carries the frontmatter keys we did not claim, so writes can put them
 * back untouched (§2.7).
 */
export interface Task {
  // -- identity ------------------------------------------------------------
  /**
   * Stable identity (§2.6.5). Never rewritten by rename, move or retitle. This is
   * what dependencies point at and what the GitHub bridge keys on.
   */
  id: string
  /** Vault path. Changes freely; never used as identity. */
  path: string

  // -- required roles (§2.2) ----------------------------------------------
  title: string
  status: StatusId
  /** Required once status is a completed value on a non-recurring task (§2.2.1). */
  completedDate?: DateOnly
  dateCreated: DateOrDateTime
  dateModified: DateOrDateTime

  // -- common roles (§2.3) -------------------------------------------------
  priority?: PriorityId
  /** PM calls this "Start". Same role. */
  scheduled?: DateOrDateTime
  due?: DateOrDateTime
  tags: string[]
  contexts: string[]
  /** Wikilinks. A subtask points at its parent task's note; both are "projects". */
  projects: LinkRef[]
  /** §2.6.7. Authoritative membership list — body embeds do not count. */
  attachments: LinkRef[]
  /** Minutes. PM's hours are a display unit only. */
  timeEstimate?: number
  timeEntries: TimeEntry[]
  blockedBy: Dependency[]
  reminders: Reminder[]

  // -- recurrence (§4) -----------------------------------------------------
  recurrence?: string
  recurrenceAnchor?: RecurrenceAnchor
  completeInstances: DateOnly[]
  skippedInstances: DateOnly[]

  // -- extensions ----------------------------------------------------------
  /** EXTENSION. 0–100. */
  progress?: number
  /** EXTENSION. Person names or wikilinks to person notes. */
  assignees: string[]
  /** EXTENSION. A zero-duration marker on the timeline. */
  milestone?: boolean
  /** EXTENSION. Values for the fields the project declares. */
  customFields: Record<string, unknown>
  /** EXTENSION. `owner/repo#123` — the GitHub bridge's foreign key. */
  ghIssue?: string
  /** EXTENSION. Fractional sort key for manual Kanban order. */
  rank?: string
  /** EXTENSION. Set by the GitHub bridge; see src/github/sync.ts. */
  ghUpdatedAt?: string
  ghHash?: string

  // -- not persisted -------------------------------------------------------
  /** Markdown body. Loaded lazily; undefined means "not read yet". */
  body?: string
  /** Frontmatter keys we do not own, preserved verbatim on write. */
  unknown: Record<string, unknown>
  archived: boolean
}

/**
 * Type is derived, never stored: a task that carries `milestone` is a milestone; one
 * whose `projects` resolves to another task is a subtask; anything else is a task.
 * Storing it would let the label contradict the structure.
 */
export type TaskType = 'task' | 'subtask' | 'milestone'

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

export const CUSTOM_FIELD_TYPES = [
  'text',
  'number',
  'date',
  'select',
  'multiselect',
  'person',
  'checkbox',
  'url'
] as const

export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number]

export interface CustomFieldDef {
  /** The frontmatter key it writes to. */
  key: string
  label: string
  type: CustomFieldType
  /** select / multiselect only. */
  options?: string[]
  icon?: string
}

export interface StatusConfig {
  id: StatusId
  label: string
  color: string
  icon: string
  /** Reaching this status stamps `completedDate`. */
  complete: boolean
  /** Left out of the click-to-cycle order, still reachable from menus. */
  skipWhenCycling?: boolean
}

export interface PriorityConfig {
  id: PriorityId
  label: string
  color: string
  icon: string
  /** Higher sorts first. */
  weight: number
}

export type ViewMode = 'table' | 'gantt' | 'kanban' | 'calendar'

/**
 * A project is a note. Its configuration lives in its own frontmatter rather than in
 * the plugin's data.json, so it survives in git, can be duplicated as a template and
 * travels with the vault. Absent fields inherit from the global settings.
 */
export interface Project {
  id: string
  path: string
  title: string
  color?: string
  icon?: string
  /** Resolved from this note's own `projects` link — projects nest like tasks do. */
  parentPath?: string
  statuses?: StatusConfig[]
  priorities?: PriorityConfig[]
  fields?: CustomFieldDef[]
  teamMembers?: string[]
  defaultView?: ViewMode
  autoSchedule?: boolean
  pullForwardOnEarlyFinish?: boolean
  autoArchiveDays?: number
  /** EXTENSION. Repos whose issues sync into this project. */
  ghRepos?: string[]
  unknown: Record<string, unknown>
}

/** A project's settings with every fallback applied. Views read this, never the raw project. */
export interface ResolvedProjectConfig {
  statuses: StatusConfig[]
  priorities: PriorityConfig[]
  fields: CustomFieldDef[]
  teamMembers: string[]
  defaultView: ViewMode
  autoSchedule: boolean
  pullForwardOnEarlyFinish: boolean
  autoArchiveDays: number
}
