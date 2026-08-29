/**
 * Issue <-> task field mapping, and the hash that makes conflict detection possible.
 *
 * The bridge syncs a deliberately small set of fields. Everything GitHub owns that has
 * no task equivalent (comments, reactions, review state) stays on GitHub, and
 * everything the vault owns that GitHub cannot hold (progress, time entries, the note
 * body) stays in the vault. Syncing more would mean inventing a canonical side for data
 * that has no natural one, and every such invention becomes a bug report.
 */

import type { GitHubIssue } from './client'
import type { Task } from '../types'

export interface GitHubSyncConfig {
  /** Statuses that map to a closed issue. Anything else maps to open. */
  closedStatuses: string[]
  /** Status applied to a task when its issue is reopened on GitHub. */
  reopenStatus: string
  /** Status applied when the issue is closed on GitHub. */
  closeStatus: string
  /** `priority:high` and friends become priority; the rest become tags. */
  priorityLabelPrefix: string
  /** Import issue labels as task tags. */
  syncLabels: boolean
  syncAssignees: boolean
  /** Push the issue title from the task title. */
  syncTitle: boolean
}

export const DEFAULT_SYNC_CONFIG: GitHubSyncConfig = {
  closedStatuses: ['done', 'cancelled'],
  reopenStatus: 'open',
  closeStatus: 'done',
  priorityLabelPrefix: 'priority:',
  syncLabels: true,
  syncAssignees: true,
  syncTitle: true
}

export interface IssueRef {
  repo: string
  number: number
}

export function parseIssueRef(value: string | undefined): IssueRef | null {
  if (!value) return null
  const match = /^([^/\s]+\/[^#\s]+)#(\d+)$/.exec(value.trim())
  if (!match) return null
  return { repo: match[1] as string, number: Number(match[2]) }
}

export function formatIssueRef(repo: string, number: number): string {
  return `${repo}#${number}`
}

/**
 * The fields the bridge owns, in a stable order, as one string.
 *
 * Conflict detection compares this hash against the one stored at the last successful
 * sync. It deliberately excludes everything the bridge does not push - otherwise
 * editing the note body or logging time would register as a local change and trigger a
 * pointless push, or worse, a false conflict.
 */
export function syncedFingerprint(task: Task, config: GitHubSyncConfig): string {
  const parts = [
    config.syncTitle ? task.title : '',
    isClosedStatus(task.status, config) ? 'closed' : 'open',
    config.syncLabels ? [...task.tags].sort().join(',') : '',
    config.syncAssignees ? [...task.assignees].sort().join(',') : '',
    task.priority ?? ''
  ]
  return hash(parts.join(' '))
}

export function isClosedStatus(status: string, config: GitHubSyncConfig): boolean {
  return config.closedStatuses.includes(status)
}

/** The task fields an issue dictates. Everything else on the task is left alone. */
export function issueToTaskPatch(
  issue: GitHubIssue,
  config: GitHubSyncConfig,
  current: Task | undefined
): Partial<Task> {
  const labels = issue.labels.map((label) => label.name)
  const priorityLabel = labels.find((name) => name.startsWith(config.priorityLabelPrefix))

  const patch: Partial<Task> = {
    title: issue.title,
    status:
      issue.state === 'closed'
        ? config.closeStatus
        : current && !isClosedStatus(current.status, config)
          ? current.status // an open issue does not disturb a local in-progress status
          : config.reopenStatus,
    ghUpdatedAt: issue.updated_at
  }

  if (issue.state === 'closed' && issue.closed_at) {
    patch.completedDate = issue.closed_at.slice(0, 10)
  } else {
    patch.completedDate = undefined
  }

  if (config.syncLabels) {
    patch.tags = labels.filter((name) => !name.startsWith(config.priorityLabelPrefix))
  }
  if (priorityLabel) {
    patch.priority = priorityLabel.slice(config.priorityLabelPrefix.length)
  }
  if (config.syncAssignees) {
    patch.assignees = issue.assignees.map((user) => user.login)
  }
  if (issue.milestone?.due_on) {
    patch.due = issue.milestone.due_on.slice(0, 10)
  }

  return patch
}

/** The issue fields a task dictates, as a PATCH body. */
export function taskToIssuePatch(
  task: Task,
  config: GitHubSyncConfig
): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    state: isClosedStatus(task.status, config) ? 'closed' : 'open'
  }
  if (config.syncTitle) patch.title = task.title
  if (config.syncLabels) {
    const labels = [...task.tags]
    if (task.priority) labels.push(`${config.priorityLabelPrefix}${task.priority}`)
    patch.labels = labels
  }
  if (config.syncAssignees) patch.assignees = task.assignees
  return patch
}

/**
 * FNV-1a. Not cryptographic - it only has to notice that a field changed, and a 32-bit
 * digest written into frontmatter stays readable in a diff.
 */
export function hash(value: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}
