/**
 * Bidirectional GitHub sync.
 *
 * The whole design rests on three fields stored per task:
 *
 *   gh-issue        owner/repo#123   the foreign key
 *   gh-updated-at   ISO timestamp    the issue's `updated_at` at the last sync
 *   gh-hash         fnv1a digest     the synced fields as they were at the last sync
 *
 * From those three we can answer, without any server-side state, the only question that
 * matters: since we last agreed, who changed?
 *
 *   remote changed = issue.updated_at !== gh-updated-at
 *   local changed  = fingerprint(task) !== gh-hash
 *
 * Neither changed, nothing to do. One changed, propagate it. Both changed, it is a real
 * conflict and the configured policy decides - and `manual` genuinely means manual: the
 * task is flagged and skipped, because silently picking a winner for someone else's
 * work is how sync tools lose data and trust.
 *
 * Loop prevention falls out of the same fields. Every write we make also rewrites
 * gh-hash and gh-updated-at to the post-write truth, so the next pass sees "neither
 * changed" and stops. Without that, our own write reads back as a local change and the
 * two sides ping-pong forever.
 */

import { Notice, type App } from 'obsidian'
import type { Task } from '../types'
import type { TaskStore } from '../store/TaskStore'
import type { TruelineSettings } from '../settings'
import { createTask } from '../store/create'
import { GitHubClient, type GitHubIssue } from './client'
import {
  formatIssueRef,
  isClosedStatus,
  issueToTaskPatch,
  parseIssueRef,
  syncedFingerprint,
  taskToIssuePatch,
  type GitHubSyncConfig
} from './mapping'

export type SyncDirection = 'pull' | 'push' | 'both'
export type ConflictPolicy = 'prefer-remote' | 'prefer-local' | 'manual'

export interface SyncReport {
  pulled: number
  pushed: number
  created: number
  conflicts: string[]
  errors: string[]
  skippedNotModified: number
}

export type SyncAction = 'none' | 'pull' | 'push' | 'conflict'

/**
 * The decision table, extracted so it can be tested without a vault or a network.
 *
 * `baseline` is what we recorded at the last successful sync: the issue's timestamp and
 * the fingerprint of the synced fields. A task with no baseline has never synced, so it
 * counts as locally changed - otherwise the first pass would conclude "nothing to do"
 * and the two sides would never meet.
 */
export function decide(input: {
  remoteUpdatedAt: string
  baselineUpdatedAt: string | undefined
  fingerprint: string
  baselineHash: string | undefined
  direction: SyncDirection
  conflictPolicy: ConflictPolicy
}): SyncAction {
  // First link: the user has just pointed a task at an existing issue and there is no
  // baseline to compare against. Adopting the issue is the only non-arbitrary choice -
  // the issue already exists and its state is the thing being linked to. Reporting a
  // conflict here would flag every newly linked task and train the user to ignore the
  // conflict list, which is worse than a wrong guess.
  if (input.baselineHash === undefined && input.baselineUpdatedAt === undefined) {
    return input.direction === 'push' ? 'push' : 'pull'
  }

  const remoteChanged = input.baselineUpdatedAt !== input.remoteUpdatedAt
  const localChanged =
    input.baselineHash === undefined || input.baselineHash !== input.fingerprint

  if (!remoteChanged && !localChanged) return 'none'

  if (remoteChanged && localChanged) {
    if (input.conflictPolicy === 'manual') return 'conflict'
    if (input.conflictPolicy === 'prefer-remote') {
      return input.direction === 'push' ? 'none' : 'pull'
    }
    return input.direction === 'pull' ? 'none' : 'push'
  }

  if (remoteChanged) return input.direction === 'push' ? 'none' : 'pull'
  return input.direction === 'pull' ? 'none' : 'push'
}

export interface SyncOptions {
  direction: SyncDirection
  conflictPolicy: ConflictPolicy
  /** Create a task note for an issue that has none yet. */
  importNewIssues: boolean
  /** Open a GitHub issue for a task that carries none. Off by default: it writes to
   *  someone else's repo, which should never be a side effect of a background poll. */
  exportNewTasks: boolean
  repos: string[]
  mapping: GitHubSyncConfig
}

export class GitHubSync {
  private readonly client: GitHubClient
  /** Per-repo high-water mark, so each poll asks only for what changed. */
  private readonly lastPolled = new Map<string, string>()
  private running = false
  private backoffUntil = 0

  constructor(
    private readonly app: App,
    private readonly tasks: TaskStore,
    private readonly settings: () => TruelineSettings
  ) {
    this.client = new GitHubClient(this.settings().github.token)
  }

  setToken(token: string): void {
    this.client.setToken(token)
  }

  verifyToken(): Promise<string> {
    return this.client.whoami()
  }

  /**
   * One full pass. Guarded against overlap: a slow pass must never run alongside the
   * next tick of the poll timer, or the same issue gets applied twice and the second
   * application looks like a conflict.
   */
  async run(options: SyncOptions): Promise<SyncReport> {
    const report: SyncReport = {
      pulled: 0,
      pushed: 0,
      created: 0,
      conflicts: [],
      errors: [],
      skippedNotModified: 0
    }

    if (this.running) {
      report.errors.push('Ya hay una sincronización en curso.')
      return report
    }
    if (Date.now() < this.backoffUntil) {
      const seconds = Math.ceil((this.backoffUntil - Date.now()) / 1000)
      report.errors.push(`Límite de peticiones de GitHub. Reintento en ${seconds}s.`)
      return report
    }

    this.running = true
    try {
      const byRef = this.indexByIssue()

      for (const repo of options.repos) {
        try {
          await this.syncRepo(repo, options, byRef, report)
        } catch (error) {
          report.errors.push(`${repo}: ${message(error)}`)
        }
      }

      if (options.direction !== 'pull') {
        await this.pushOrphans(options, report)
      }
    } finally {
      this.running = false
    }

    return report
  }

  // -- per repo ------------------------------------------------------------

  private async syncRepo(
    repo: string,
    options: SyncOptions,
    byRef: Map<string, Task>,
    report: SyncReport
  ): Promise<void> {
    const result = await this.client.pollIssues(repo, this.lastPolled.get(repo))

    if (result.retryAfter) {
      this.backoffUntil = Date.now() + result.retryAfter * 1000
      report.errors.push(`${repo}: límite de peticiones, esperando ${result.retryAfter}s.`)
      return
    }
    if (result.notModified) {
      report.skippedNotModified++
      return
    }

    // Advance the mark only after a successful pass, so a mid-pass failure re-reads the
    // same window next time instead of skipping issues we never applied.
    let newest = this.lastPolled.get(repo)

    for (const issue of result.issues) {
      const ref = formatIssueRef(repo, issue.number)
      const task = byRef.get(ref)

      try {
        if (!task) {
          if (options.importNewIssues && options.direction !== 'push') {
            await this.importIssue(repo, issue, options, report)
          }
        } else {
          await this.reconcile(task, repo, issue, options, report)
        }
      } catch (error) {
        report.errors.push(`${ref}: ${message(error)}`)
      }

      if (!newest || issue.updated_at > newest) newest = issue.updated_at
    }

    if (newest) this.lastPolled.set(repo, newest)
  }

  /**
   * The decision table. Everything above exists to make this function's four branches
   * unambiguous.
   */
  private async reconcile(
    task: Task,
    repo: string,
    issue: GitHubIssue,
    options: SyncOptions,
    report: SyncReport
  ): Promise<void> {
    const action = decide({
      remoteUpdatedAt: issue.updated_at,
      baselineUpdatedAt: task.ghUpdatedAt,
      fingerprint: syncedFingerprint(task, options.mapping),
      baselineHash: task.ghHash,
      direction: options.direction,
      conflictPolicy: options.conflictPolicy
    })

    switch (action) {
      case 'pull':
        await this.applyIssue(task, issue, options, report)
        return
      case 'push':
        await this.applyTask(task, repo, issue, options, report)
        return
      case 'conflict':
        report.conflicts.push(`${formatIssueRef(repo, issue.number)} - ${task.title}`)
        return
      default:
        return
    }
  }

  /** GitHub wins: write the issue's fields onto the task and re-baseline. */
  private async applyIssue(
    task: Task,
    issue: GitHubIssue,
    options: SyncOptions,
    report: SyncReport
  ): Promise<void> {
    const patch = issueToTaskPatch(issue, options.mapping, task)
    const merged: Task = { ...task, ...patch }
    await this.tasks.update(task.path, {
      ...patch,
      ghUpdatedAt: issue.updated_at,
      ghHash: syncedFingerprint(merged, options.mapping)
    })
    report.pulled++
  }

  /** The vault wins: PATCH the issue, then re-baseline from what GitHub echoed back. */
  private async applyTask(
    task: Task,
    repo: string,
    issue: GitHubIssue,
    options: SyncOptions,
    report: SyncReport
  ): Promise<void> {
    const updated = await this.client.updateIssue(
      repo,
      issue.number,
      taskToIssuePatch(task, options.mapping)
    )
    await this.tasks.update(task.path, {
      ghUpdatedAt: updated.updated_at,
      ghHash: syncedFingerprint(task, options.mapping)
    })
    report.pushed++
  }

  private async importIssue(
    repo: string,
    issue: GitHubIssue,
    options: SyncOptions,
    report: SyncReport
  ): Promise<void> {
    const settings = this.settings()
    const file = await createTask(this.app, settings, {
      title: issue.title,
      status: issue.state === 'closed' ? options.mapping.closeStatus : options.mapping.reopenStatus,
      body: issueBody(issue)
    })

    // The store indexes on the metadata-cache event, which has not fired yet for a file
    // created microseconds ago; wait for it rather than racing it.
    const task = await this.awaitIndex(file.path)
    if (!task) {
      report.errors.push(`No se pudo indexar ${file.path}`)
      return
    }

    const patch = issueToTaskPatch(issue, options.mapping, undefined)
    const merged: Task = { ...task, ...patch }
    await this.tasks.update(task.path, {
      ...patch,
      ghIssue: formatIssueRef(repo, issue.number),
      ghUpdatedAt: issue.updated_at,
      ghHash: syncedFingerprint(merged, options.mapping)
    })
    report.created++
  }

  /** Tasks that carry no issue yet, when the user asked for export. */
  private async pushOrphans(options: SyncOptions, report: SyncReport): Promise<void> {
    if (!options.exportNewTasks) return
    const target = options.repos[0]
    if (!target) return

    for (const task of this.tasks.all()) {
      if (task.ghIssue || task.archived) continue
      try {
        const issue = await this.client.createIssue(target, {
          title: task.title,
          body: `Creado desde Obsidian.\n\nid: ${task.id}`,
          labels: options.mapping.syncLabels ? task.tags : undefined
        })
        await this.tasks.update(task.path, {
          ghIssue: formatIssueRef(target, issue.number),
          ghUpdatedAt: issue.updated_at,
          ghHash: syncedFingerprint(task, options.mapping)
        })
        report.created++
      } catch (error) {
        report.errors.push(`${task.title}: ${message(error)}`)
      }
    }
  }

  // -- helpers -------------------------------------------------------------

  private indexByIssue(): Map<string, Task> {
    const map = new Map<string, Task>()
    for (const task of this.tasks.all()) {
      const ref = parseIssueRef(task.ghIssue)
      if (ref) map.set(formatIssueRef(ref.repo, ref.number), task)
    }
    return map
  }

  private async awaitIndex(path: string, attempts = 20): Promise<Task | undefined> {
    for (let i = 0; i < attempts; i++) {
      const task = this.tasks.get(path)
      if (task) return task
      await sleep(50)
    }
    return undefined
  }
}

/** A one-line summary suitable for a Notice. */
export function describeReport(report: SyncReport): string {
  const parts: string[] = []
  if (report.created) parts.push(`${report.created} creadas`)
  if (report.pulled) parts.push(`${report.pulled} actualizadas desde GitHub`)
  if (report.pushed) parts.push(`${report.pushed} enviadas a GitHub`)
  if (report.conflicts.length) parts.push(`${report.conflicts.length} conflictos`)
  if (report.errors.length) parts.push(`${report.errors.length} errores`)
  return parts.length ? parts.join(', ') : 'Sin cambios'
}

export function notifyReport(report: SyncReport): void {
  new Notice(`GitHub: ${describeReport(report)}`)
}

function issueBody(issue: GitHubIssue): string {
  const header = `[${issue.html_url}](${issue.html_url})\n\n`
  return header + (issue.body ?? '')
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function isClosed(task: Task, config: GitHubSyncConfig): boolean {
  return isClosedStatus(task.status, config)
}
