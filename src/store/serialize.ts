/**
 * Frontmatter <-> Task translation.
 *
 * Two invariants drive everything here:
 *
 *  1. Reading is forgiving. A vault is written by many tools; scalars turn up where
 *     lists belong, dependencies arrive as bare strings, dates carry a time or not.
 *     We normalize on read and never reject a file for being untidy.
 *
 *  2. Writing is conservative. We emit canonical keys only (§2.4.3) and put every
 *     key we do not own back exactly as we found it (§2.7). A task edited here and
 *     then opened in TaskNotes, its CLI or Project Manager must lose nothing.
 */

import type { Dependency, RelType, Reminder, Task, TimeEntry } from '../types'
import {
  DEFAULT_MAPPING,
  type FieldMapping,
  type MappingIssue,
  ownedKeys,
  resolveRole
} from './mapping'

const REL_TYPES: RelType[] = [
  'FINISHTOSTART',
  'FINISHTOFINISH',
  'STARTTOSTART',
  'STARTTOFINISH'
]

export interface ParseResult {
  task: Task
  issues: MappingIssue[]
}

export interface ParseContext {
  path: string
  /** Used when the title role is absent, and when title storage is `filename`. */
  basename: string
  mapping?: FieldMapping
  /** Generated only when the file carries no stable id yet. */
  generateId: () => string
}

export function parseTask(
  frontmatter: Record<string, unknown>,
  ctx: ParseContext
): ParseResult {
  const mapping = ctx.mapping ?? DEFAULT_MAPPING
  const issues: MappingIssue[] = []

  const read = (role: Parameters<typeof resolveRole>[1]): unknown => {
    const result = resolveRole(frontmatter, role, mapping)
    issues.push(...result.issues)
    return result.value
  }

  const now = new Date().toISOString()

  const task: Task = {
    id: str(read('id')) ?? ctx.generateId(),
    path: ctx.path,
    // §2.2.2: mapped title wins under `frontmatter` storage, basename is the fallback.
    title: str(read('title')) ?? ctx.basename,
    status: str(read('status')) ?? 'open',
    completedDate: str(read('completed_date')),
    dateCreated: str(read('date_created')) ?? now,
    dateModified: str(read('date_modified')) ?? now,

    priority: str(read('priority')),
    scheduled: str(read('scheduled')),
    due: str(read('due')),
    tags: strList(read('tags')),
    contexts: strList(read('contexts')),
    projects: strList(read('projects')),
    attachments: strList(read('attachments')),
    timeEstimate: num(read('time_estimate')),
    timeEntries: parseTimeEntries(read('time_entries')),
    blockedBy: parseDependencies(read('blocked_by')),
    reminders: parseReminders(read('reminders')),

    recurrence: str(read('recurrence')),
    recurrenceAnchor: enumOf(read('recurrence_anchor'), ['scheduled', 'completion']),
    completeInstances: strList(read('complete_instances')),
    skippedInstances: strList(read('skipped_instances')),

    progress: clampProgress(num(read('progress'))),
    assignees: strList(read('assignees')),
    milestone: bool(read('milestone')),
    customFields: {},
    ghIssue: str(read('gh_issue')),

    unknown: {},
    archived: bool(read('archived')) ?? false
  }

  // Everything we did not claim is either a project-declared custom field or a key
  // belonging to another tool. Both are preserved; the store decides which is which
  // once it knows the task's project.
  const owned = ownedKeys(mapping)
  for (const [key, value] of Object.entries(frontmatter)) {
    if (owned.has(key)) continue
    if (key === 'position') continue // Obsidian's own cache artefact
    task.unknown[key] = value
  }

  return { task, issues }
}

/**
 * Builds the frontmatter object to persist.
 *
 * Empty values are deleted rather than written as `null` or `[]`: a frontmatter full
 * of empty keys is noise in every other tool that reads the file, and the spec treats
 * absent and empty as the same thing for every optional role.
 */
export function serializeTask(
  task: Task,
  declaredFieldKeys: string[] = [],
  mapping: FieldMapping = DEFAULT_MAPPING
): Record<string, unknown> {
  const out: Record<string, unknown> = {}

  // Unknown keys first, so a canonical key always wins a collision.
  for (const [key, value] of Object.entries(task.unknown)) out[key] = value
  for (const key of declaredFieldKeys) {
    if (key in task.customFields) out[key] = task.customFields[key]
  }

  const put = (role: Parameters<typeof resolveRole>[1], value: unknown): void => {
    const key = mapping[role]
    if (isEmpty(value)) delete out[key]
    else out[key] = value
  }

  put('id', task.id)
  put('title', task.title)
  put('status', task.status)
  put('completed_date', task.completedDate)
  put('date_created', task.dateCreated)
  put('date_modified', task.dateModified)
  put('priority', task.priority)
  put('scheduled', task.scheduled)
  put('due', task.due)
  put('tags', task.tags)
  put('contexts', task.contexts)
  put('projects', task.projects)
  put('attachments', task.attachments)
  put('time_estimate', task.timeEstimate)
  put('time_entries', task.timeEntries.length ? task.timeEntries : undefined)
  put('blocked_by', task.blockedBy.length ? task.blockedBy : undefined)
  put('reminders', task.reminders.length ? task.reminders : undefined)
  put('recurrence', task.recurrence)
  put('recurrence_anchor', task.recurrence ? task.recurrenceAnchor : undefined)
  put('complete_instances', task.completeInstances)
  put('skipped_instances', task.skippedInstances)
  put('progress', task.progress)
  put('assignees', task.assignees)
  put('milestone', task.milestone ? true : undefined)
  put('gh_issue', task.ghIssue)
  put('archived', task.archived ? true : undefined)

  return out
}

// ---------------------------------------------------------------------------
// Coercion
// ---------------------------------------------------------------------------

function str(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  // A YAML date literal arrives as a Date; keep the calendar day, drop the timezone
  // guesswork that `toISOString()` would introduce for a bare date.
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return undefined
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function bool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return undefined
}

/** Scalars normalize to a one-item list — §2.6.7 mandates it for attachments. */
function strList(value: unknown): string[] {
  if (value === undefined || value === null) return []
  const raw = Array.isArray(value) ? value : [value]
  const out: string[] = []
  for (const item of raw) {
    const s = str(item)
    if (s && !out.includes(s)) out.push(s)
  }
  return out
}

function enumOf<T extends string>(value: unknown, allowed: T[]): T | undefined {
  const s = str(value)
  return s && (allowed as string[]).includes(s) ? (s as T) : undefined
}

function clampProgress(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  return Math.max(0, Math.min(100, Math.round(value)))
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true
  if (Array.isArray(value) && value.length === 0) return true
  return false
}

function parseTimeEntries(value: unknown): TimeEntry[] {
  if (!Array.isArray(value)) return []
  const out: TimeEntry[] = []
  for (const raw of value) {
    if (!isRecord(raw)) continue

    // Project Manager's shape: { date, hours, note }. Rebuild it as an interval so
    // the canonical duration stays derived rather than stored (§2.6.1).
    const legacyDate = str(raw.date)
    const legacyHours = num(raw.hours)
    if (legacyDate && legacyHours !== undefined && !raw.startTime) {
      const start = new Date(`${legacyDate}T09:00:00`)
      const end = new Date(start.getTime() + legacyHours * 3_600_000)
      out.push({
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        ...(str(raw.note) ? { description: str(raw.note) as string } : {})
      })
      continue
    }

    const startTime = str(raw.startTime)
    if (!startTime) continue
    const endTime = str(raw.endTime)
    const description = str(raw.description)
    out.push({
      startTime,
      ...(endTime ? { endTime } : {}),
      ...(description ? { description } : {})
    })
  }

  // §2.6.1: at most one running entry. Keep the most recent, close the rest is not
  // our call — flag it by leaving only the last open one open.
  let seenOpen = false
  for (let i = out.length - 1; i >= 0; i--) {
    const entry = out[i]
    if (!entry || entry.endTime) continue
    if (seenOpen) entry.endTime = entry.startTime
    seenOpen = true
  }
  return out
}

function parseDependencies(value: unknown): Dependency[] {
  if (value === undefined || value === null) return []
  const raw = Array.isArray(value) ? value : [value]
  const out: Dependency[] = []
  for (const item of raw) {
    // A bare string is the common shorthand, and what Project Manager stores.
    if (typeof item === 'string') {
      const uid = item.trim()
      if (uid) out.push({ uid, reltype: 'FINISHTOSTART' })
      continue
    }
    if (!isRecord(item)) continue
    const uid = str(item.uid)
    if (!uid) continue
    const reltype = enumOf(item.reltype, REL_TYPES) ?? 'FINISHTOSTART'
    const gap = str(item.gap)
    out.push({ uid, reltype, ...(gap ? { gap } : {}) })
  }
  return out
}

function parseReminders(value: unknown): Reminder[] {
  if (!Array.isArray(value)) return []
  const out: Reminder[] = []
  for (const raw of value) {
    if (!isRecord(raw)) continue
    const id = str(raw.id)
    if (!id) continue
    const description = str(raw.description)
    const type = enumOf(raw.type, ['absolute', 'relative'] as const)

    if (type === 'absolute') {
      const absoluteTime = str(raw.absoluteTime)
      if (!absoluteTime) continue
      out.push({ id, type, absoluteTime, ...(description ? { description } : {}) })
    } else if (type === 'relative') {
      const offset = str(raw.offset)
      const relatedTo = enumOf(raw.relatedTo, ['due', 'scheduled'] as const) ?? 'due'
      if (!offset) continue
      out.push({ id, type, relatedTo, offset, ...(description ? { description } : {}) })
    }
  }
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
