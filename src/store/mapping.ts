/**
 * Semantic role <-> frontmatter key mapping (spec §2.4, §2.5).
 *
 * Rules the spec imposes and this module enforces:
 *   - every supported role has exactly one canonical write key (§2.4.1)
 *   - readers try the canonical key first, then configured aliases (§2.4.2)
 *   - when both exist, the canonical value wins and we warn (`alias_conflict_ignored`)
 *   - writers only ever emit canonical keys (§2.4.3)
 */

export type SemanticRole =
  // required (§2.2)
  | 'id'
  | 'title'
  | 'status'
  | 'completed_date'
  | 'date_created'
  | 'date_modified'
  // common (§2.3)
  | 'priority'
  | 'due'
  | 'scheduled'
  | 'tags'
  | 'contexts'
  | 'projects'
  | 'attachments'
  | 'time_estimate'
  | 'time_entries'
  | 'recurrence'
  | 'recurrence_anchor'
  | 'complete_instances'
  | 'skipped_instances'
  | 'blocked_by'
  | 'reminders'
  | 'archived'
  // extensions
  | 'progress'
  | 'assignees'
  | 'milestone'
  | 'gh_issue'
  | 'gh_updated_at'
  | 'gh_hash'
  | 'rank'

export type FieldMapping = Record<SemanticRole, string>

/**
 * Canonical keys. These match what TaskNotes itself writes, so a vault stays readable
 * by both plugins without a migration. Users can remap any of them in settings.
 */
export const DEFAULT_MAPPING: FieldMapping = {
  id: 'id',
  title: 'title',
  status: 'status',
  completed_date: 'completedDate',
  date_created: 'dateCreated',
  date_modified: 'dateModified',
  priority: 'priority',
  due: 'due',
  scheduled: 'scheduled',
  tags: 'tags',
  contexts: 'contexts',
  projects: 'projects',
  attachments: 'attachments',
  time_estimate: 'timeEstimate',
  time_entries: 'timeEntries',
  recurrence: 'recurrence',
  recurrence_anchor: 'recurrence_anchor',
  complete_instances: 'complete_instances',
  skipped_instances: 'skipped_instances',
  blocked_by: 'blockedBy',
  reminders: 'reminders',
  archived: 'archived',
  progress: 'progress',
  assignees: 'assignees',
  milestone: 'milestone',
  gh_issue: 'gh-issue',
  gh_updated_at: 'gh-updated-at',
  gh_hash: 'gh-hash',
  rank: 'pn-rank'
}

/**
 * Read-only aliases (§2.5). Accepting these is what lets us open a vault written by
 * an older TaskNotes, by its CLI, or by Project Manager without touching a file.
 */
export const READ_ALIASES: Partial<Record<SemanticRole, string[]>> = {
  completed_date: ['completed_date', 'completed'],
  date_created: ['date_created', 'created', 'createdAt'],
  date_modified: ['date_modified', 'modified', 'updatedAt'],
  time_estimate: ['time_estimate', 'estimate'],
  time_entries: ['time_entries', 'timeLogs'],
  blocked_by: ['blocked_by', 'dependencies'],
  recurrence_anchor: ['recurrenceAnchor'],
  complete_instances: ['completeInstances'],
  skipped_instances: ['skippedInstances'],
  // Project Manager wrote Start into `start`; same semantic role as `scheduled`.
  scheduled: ['start'],
  attachments: []
}

export interface MappingIssue {
  code: 'alias_conflict_ignored' | 'unknown_alias'
  role: SemanticRole
  canonicalKey: string
  aliasKey: string
}

export interface ResolveResult<T> {
  value: T | undefined
  issues: MappingIssue[]
}

/**
 * Resolves one semantic role out of a raw frontmatter object.
 *
 * The order is normative: canonical first, then aliases in declaration order. When the
 * canonical key is present the alias value is dropped, never merged — merging is how
 * you get a task whose due date depends on which key the last tool happened to write.
 */
export function resolveRole(
  frontmatter: Record<string, unknown>,
  role: SemanticRole,
  mapping: FieldMapping = DEFAULT_MAPPING
): ResolveResult<unknown> {
  const canonicalKey = mapping[role]
  const issues: MappingIssue[] = []
  const aliases = READ_ALIASES[role] ?? []

  const canonicalPresent = isPresent(frontmatter[canonicalKey])

  for (const aliasKey of aliases) {
    if (aliasKey === canonicalKey) continue
    if (!isPresent(frontmatter[aliasKey])) continue
    if (canonicalPresent) {
      issues.push({ code: 'alias_conflict_ignored', role, canonicalKey, aliasKey })
    } else {
      return { value: frontmatter[aliasKey], issues }
    }
  }

  return { value: canonicalPresent ? frontmatter[canonicalKey] : undefined, issues }
}

/** Every frontmatter key this mapping claims, canonical and alias alike. */
export function ownedKeys(mapping: FieldMapping = DEFAULT_MAPPING): Set<string> {
  const keys = new Set<string>(Object.values(mapping))
  for (const aliases of Object.values(READ_ALIASES)) {
    for (const alias of aliases ?? []) keys.add(alias)
  }
  return keys
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== ''
}
