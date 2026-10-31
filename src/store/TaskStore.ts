/**
 * The in-memory index every view reads from.
 *
 * Design notes:
 *
 *  - Two indexes, one truth. `byPath` answers "what is in this file", `byId` answers
 *    "what does this dependency point at". Paths move, ids do not, so anything
 *    durable (dependencies, the GitHub bridge) keys on the id and only the id.
 *
 *  - Writes go through Obsidian's `processFrontMatter`, which edits the YAML block in
 *    place. Rewriting the file ourselves would mean re-serializing the body, and the
 *    body is where the user's actual notes live.
 *
 *  - A change that does not change the task is not a change. Every write we make
 *    comes back as a metadata event once Obsidian reparses the file, and so does every
 *    autosave while you type in a task's body. Both re-parse to the same task, so
 *    `ingest` compares the result with what it already holds and stays quiet when they
 *    match: no event, no repaint.
 *
 *    An earlier version tried to skip our own echoes with a set of paths being written,
 *    cleared in a `finally` after `processFrontMatter` resolved. It never matched: the
 *    metadata event arrives later, when Obsidian finishes reparsing asynchronously, by
 *    which time the path was already gone from the set. Comparing content does not
 *    depend on timing, and it also catches the body edits the path set never could.
 *
 *    Note what this guard is *not*: the GitHub bridge's protection against write loops.
 *    That comes from `gh-hash` and `gh-updated-at` (see github/sync.ts), and holds even
 *    when an echo does get through.
 */

import type { App, CachedMetadata, TFile } from 'obsidian'
import { TFile as ObsidianTFile } from 'obsidian'
import type { Task } from '../types'
import { DEFAULT_MAPPING, type FieldMapping } from './mapping'
import { parseTask, serializeTask } from './serialize'
import { parseLink, stripExtension } from './links'

export interface TaskIdentification {
  /** `property` matches frontmatter; `tag` matches an Obsidian tag. */
  mode: 'property' | 'tag'
  /** Property key, or tag name without `#`. */
  key: string
  /** Property mode only. Empty or absent accepts any non-empty value. */
  value?: string
}

export interface TaskStoreOptions {
  identification: TaskIdentification
  mapping?: FieldMapping
  /** Folder new tasks are created in. */
  tasksFolder: string
}

export type StoreEvent = 'changed'

/** What a single ingest did, so callers emit only when something visible happened. */
type IngestResult = 'changed' | 'unchanged' | 'removed' | 'absent'

export class TaskStore {
  private readonly byPath = new Map<string, Task>()
  private readonly byId = new Map<string, Task>()
  private readonly listeners = new Set<() => void>()
  private readonly mapping: FieldMapping
  private options: TaskStoreOptions

  constructor(
    private readonly app: App,
    options: TaskStoreOptions
  ) {
    // Copied, not aliased. Holding the settings object itself meant a change made in
    // the settings tab half-applied: new notes were judged by the new key, the notes
    // already indexed by the old one, and nothing re-scanned until a restart.
    this.options = structuredClone(options)
    this.mapping = options.mapping ?? DEFAULT_MAPPING
  }

  /**
   * Applies new options and re-indexes the vault. The only way to change how tasks are
   * identified; see the constructor for why it cannot happen by mutation.
   */
  setOptions(options: Partial<TaskStoreOptions>): void {
    this.options = { ...this.options, ...structuredClone(options) }
    this.rebuild()
  }

  // -- lifecycle -----------------------------------------------------------

  /** Full scan. Cheap enough to run on load: it reads the metadata cache, not disk. */
  rebuild(): void {
    // Kept so a re-scan does not hand fresh ids and dates to notes that carry none in
    // their frontmatter; see `ingest`.
    const previous = new Map(this.byPath)
    this.byPath.clear()
    this.byId.clear()
    for (const file of this.app.vault.getMarkdownFiles()) {
      this.ingest(file, undefined, previous.get(file.path))
    }
    this.emit()
  }

  onFileChanged(file: TFile, _data: string, cache: CachedMetadata): void {
    const result = this.ingest(file, cache)
    if (result === 'changed' || result === 'removed') this.emit()
  }

  onFileDeleted(path: string): void {
    const task = this.byPath.get(path)
    if (!task) return
    this.byPath.delete(path)
    if (this.byId.get(task.id) === task) this.byId.delete(task.id)
    this.emit()
  }

  onFileRenamed(file: TFile, oldPath: string): void {
    const task = this.byPath.get(oldPath)
    if (task) {
      this.byPath.delete(oldPath)
      task.path = file.path
      this.byPath.set(file.path, task)
    }
    // Obsidian rewrites wikilinks pointing at the renamed file, and those rewrites
    // arrive as ordinary metadata changes. Nothing to fix up here.
    this.ingest(file)
    this.emit()
  }

  // -- reads ---------------------------------------------------------------

  all(): Task[] {
    return [...this.byPath.values()]
  }

  get(path: string): Task | undefined {
    return this.byPath.get(path)
  }

  getById(id: string): Task | undefined {
    return this.byId.get(id)
  }

  /**
   * Resolves a reference to the task it names (§11.4): wikilink or path first, stable
   * id last. Returns undefined for a link that points at a note which is not a task —
   * that is the normal case for a plain project note.
   */
  resolve(ref: string, sourcePath = ''): Task | undefined {
    const { target } = parseLink(ref)
    const file = this.app.metadataCache.getFirstLinkpathDest(
      stripExtension(target),
      sourcePath
    )
    if (file) {
      const byPath = this.byPath.get(file.path)
      if (byPath) return byPath
    }
    return this.byId.get(target)
  }

  /** Tasks whose `projects` names this note. Covers both subtasks and project members. */
  childrenOf(path: string): Task[] {
    const out: Task[] = []
    for (const task of this.byPath.values()) {
      if (task.path === path) continue
      for (const ref of task.projects) {
        const { target } = parseLink(ref)
        const file = this.app.metadataCache.getFirstLinkpathDest(
          stripExtension(target),
          task.path
        )
        if (file?.path === path) {
          out.push(task)
          break
        }
      }
    }
    return out
  }

  // -- writes --------------------------------------------------------------

  /**
   * Applies a patch to a task's frontmatter. The task passed in is the store's own
   * object, so callers must not mutate it directly — this is the only write path.
   */
  async update(path: string, patch: Partial<Task>, declaredFieldKeys: string[] = []): Promise<void> {
    const current = this.byPath.get(path)
    if (!current) throw new Error(`Not a known task: ${path}`)
    const file = this.app.vault.getAbstractFileByPath(path)
    if (!(file instanceof ObsidianTFile)) throw new Error(`Missing file: ${path}`)

    const next: Task = {
      ...current,
      ...patch,
      // Identity and location are never patchable.
      id: current.id,
      path: current.path,
      dateModified: new Date().toISOString()
    }

    const frontmatter = serializeTask(next, declaredFieldKeys, this.mapping)

    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      for (const key of Object.keys(fm)) {
        if (!(key in frontmatter)) delete fm[key]
      }
      Object.assign(fm, frontmatter)
    })

    // Indexed now rather than on the echo, so a caller that reads straight after the
    // write sees it. The echo then re-parses to this same task and is ignored.
    this.byPath.set(path, next)
    this.byId.set(next.id, next)
    this.emit()
  }

  // -- events --------------------------------------------------------------

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }

  // -- internals -----------------------------------------------------------

  private ingest(
    file: TFile,
    cache?: CachedMetadata,
    previous: Task | undefined = this.byPath.get(file.path)
  ): IngestResult {
    const meta = cache ?? this.app.metadataCache.getFileCache(file)
    if (!meta || !this.isTask(meta)) {
      if (!this.byPath.has(file.path)) return 'absent'
      this.onFileDeletedQuiet(file.path)
      return 'removed'
    }

    const frontmatter = (meta.frontmatter ?? {}) as Record<string, unknown>
    const { task } = parseTask(frontmatter, {
      path: file.path,
      basename: file.basename,
      mapping: this.mapping,
      // A note with no `id` or dates in its frontmatter gets them invented on parse.
      // Reusing what we invented last time keeps them stable for the session; without
      // it every autosave minted a new id, and no re-parse ever compared equal.
      previous,
      generateId: () => makeId(file.basename)
    })

    const indexed = this.byPath.get(file.path)
    if (indexed && sameTask(indexed, task, this.mapping)) return 'unchanged'

    if (indexed && indexed.id !== task.id && this.byId.get(indexed.id) === indexed) {
      this.byId.delete(indexed.id)
    }
    this.byPath.set(file.path, task)
    this.byId.set(task.id, task)
    return 'changed'
  }

  private onFileDeletedQuiet(path: string): void {
    const task = this.byPath.get(path)
    if (!task) return
    this.byPath.delete(path)
    if (this.byId.get(task.id) === task) this.byId.delete(task.id)
  }

  private isTask(meta: CachedMetadata): boolean {
    const { mode, key, value } = this.options.identification
    if (mode === 'tag') {
      const inline = meta.tags?.some((t) => t.tag === `#${key}`) ?? false
      const fmTags = meta.frontmatter?.tags
      const inFm = Array.isArray(fmTags)
        ? fmTags.some((t) => String(t).replace(/^#/, '') === key)
        : String(fmTags ?? '').replace(/^#/, '') === key
      return inline || inFm
    }
    if (matchesProperty(meta.frontmatter?.[key], value)) return true
    // Notes created before the rename to Trueline carry the old default key. Reading it
    // keeps them visible; they are not rewritten, so nothing changes until the user does.
    const legacy = LEGACY_TASK_KEYS[key]
    return legacy !== undefined && matchesProperty(meta.frontmatter?.[legacy], value)
  }
}

/** Old default identification keys, by the key that replaced them. */
const LEGACY_TASK_KEYS: Record<string, string> = { 'tl-task': 'pn-task' }

function matchesProperty(raw: unknown, value: string | undefined): boolean {
  if (raw === undefined || raw === null || raw === false || raw === '') return false
  // Empty means "any value": it is stored as '' because JSON cannot store undefined,
  // and an undefined dropped from data.json would come back as the default 'true'.
  return !value || String(raw) === value
}

/**
 * Two parses of the same file describe the same task when everything we would write
 * back is identical. Comparing the serialized form, not the objects, ignores what is
 * not persisted (the body, field order) and counts what is (unknown keys included).
 */
function sameTask(a: Task, b: Task, mapping: FieldMapping): boolean {
  if (a.path !== b.path) return false
  return (
    stableStringify(serializeTask(a, [], mapping)) ===
    stableStringify(serializeTask(b, [], mapping))
  )
}

/** JSON with object keys sorted, so key order in the YAML cannot make equal look unequal. */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item
    return Object.fromEntries(
      Object.entries(item as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : 1))
    )
  })
}

/**
 * Stable ids are readable on purpose: they show up in `blockedBy` and in git diffs,
 * and an opaque uuid there costs more in debugging than it saves in bytes.
 */
function makeId(basename: string): string {
  const slug = basename
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
  const suffix = Math.random().toString(36).slice(2, 8)
  return slug ? `${slug}-${suffix}` : `task-${suffix}`
}
