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
 *  - We never write in response to our own write. `pendingWrites` holds the paths we
 *    are touching so the metadata-change callback can ignore the echo; without it the
 *    store and the plugins reading the same file feed each other forever.
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
  /** Property mode only. Omit to accept any truthy value. */
  value?: string
}

export interface TaskStoreOptions {
  identification: TaskIdentification
  mapping?: FieldMapping
  /** Folder new tasks are created in. */
  tasksFolder: string
}

export type StoreEvent = 'changed'

export class TaskStore {
  private readonly byPath = new Map<string, Task>()
  private readonly byId = new Map<string, Task>()
  private readonly listeners = new Set<() => void>()
  private readonly pendingWrites = new Set<string>()
  private readonly mapping: FieldMapping

  constructor(
    private readonly app: App,
    private options: TaskStoreOptions
  ) {
    this.mapping = options.mapping ?? DEFAULT_MAPPING
  }

  // -- lifecycle -----------------------------------------------------------

  /** Full scan. Cheap enough to run on load: it reads the metadata cache, not disk. */
  rebuild(): void {
    this.byPath.clear()
    this.byId.clear()
    for (const file of this.app.vault.getMarkdownFiles()) {
      this.ingest(file)
    }
    this.emit()
  }

  onFileChanged(file: TFile, _data: string, cache: CachedMetadata): void {
    if (this.pendingWrites.has(file.path)) return
    const had = this.byPath.has(file.path)
    const has = this.ingest(file, cache)
    if (had || has) this.emit()
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

    this.pendingWrites.add(path)
    try {
      await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
        for (const key of Object.keys(fm)) {
          if (!(key in frontmatter)) delete fm[key]
        }
        Object.assign(fm, frontmatter)
      })
    } finally {
      this.pendingWrites.delete(path)
    }

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

  /** Returns true when the file is (still) a task. */
  private ingest(file: TFile, cache?: CachedMetadata): boolean {
    const meta = cache ?? this.app.metadataCache.getFileCache(file)
    if (!meta || !this.isTask(meta)) {
      this.onFileDeletedQuiet(file.path)
      return false
    }

    const frontmatter = (meta.frontmatter ?? {}) as Record<string, unknown>
    const { task } = parseTask(frontmatter, {
      path: file.path,
      basename: file.basename,
      mapping: this.mapping,
      generateId: () => makeId(file.basename)
    })

    this.byPath.set(file.path, task)
    this.byId.set(task.id, task)
    return true
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
  return value === undefined || String(raw) === value
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
