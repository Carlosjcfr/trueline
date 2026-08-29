/**
 * Projects are notes, and their configuration lives in their own frontmatter.
 *
 * That is the one deliberate departure from Project Manager, which keeps per-project
 * statuses, fields and view preferences in the plugin's `data.json`. Putting them in
 * the note means the configuration is versioned with the vault, survives uninstalling
 * the plugin, can be duplicated as a template, and can be edited by hand.
 *
 * Config inherits down the project tree: a child project that declares nothing gets
 * its parent's statuses, its parent's fields, and finally the global defaults.
 */

import type { App, TFile } from 'obsidian'
import { TFile as ObsidianTFile } from 'obsidian'
import type {
  CustomFieldDef,
  PriorityConfig,
  Project,
  ResolvedProjectConfig,
  StatusConfig,
  ViewMode
} from '../types'
import type { ProjectNotesSettings } from '../settings'
import { parseLink, stripExtension } from './links'

const PROJECT_KEY = 'pn-project'

export class ProjectStore {
  private readonly byPath = new Map<string, Project>()

  constructor(
    private readonly app: App,
    private readonly settings: () => ProjectNotesSettings
  ) {}

  rebuild(): void {
    this.byPath.clear()
    for (const file of this.app.vault.getMarkdownFiles()) this.ingest(file)
    // Parents resolve in a second pass: a project may be declared after its child.
    for (const project of this.byPath.values()) {
      project.parentPath = this.resolveParent(project)
    }
  }

  all(): Project[] {
    return [...this.byPath.values()]
  }

  get(path: string): Project | undefined {
    return this.byPath.get(path)
  }

  /**
   * The config a view should read: the project's own values, then each ancestor's,
   * then the global settings. Walks the chain with a visited set, because a vault can
   * always contain a project that is its own grandparent.
   */
  resolve(path: string | undefined): ResolvedProjectConfig {
    const settings = this.settings()
    const chain: Project[] = []
    const seen = new Set<string>()

    let current = path ? this.byPath.get(path) : undefined
    while (current && !seen.has(current.path)) {
      seen.add(current.path)
      chain.push(current)
      current = current.parentPath ? this.byPath.get(current.parentPath) : undefined
    }

    const pick = <T>(read: (p: Project) => T | undefined, fallback: T): T => {
      for (const project of chain) {
        const value = read(project)
        if (value !== undefined) return value
      }
      return fallback
    }

    return {
      statuses: pick<StatusConfig[]>((p) => p.statuses, settings.statuses),
      priorities: pick<PriorityConfig[]>((p) => p.priorities, settings.priorities),
      // Fields accumulate down the chain instead of overriding: an area-wide field
      // should still apply to a sub-project that adds two of its own.
      fields: mergeFields(chain, settings.fields),
      teamMembers: pick<string[]>((p) => p.teamMembers, settings.teamMembers),
      defaultView: pick<ViewMode>((p) => p.defaultView, settings.defaultView),
      autoSchedule: pick<boolean>((p) => p.autoSchedule, settings.autoSchedule),
      pullForwardOnEarlyFinish: pick<boolean>(
        (p) => p.pullForwardOnEarlyFinish,
        settings.pullForwardOnEarlyFinish
      ),
      autoArchiveDays: pick<number>((p) => p.autoArchiveDays, settings.autoArchiveDays)
    }
  }

  private ingest(file: TFile): void {
    const meta = this.app.metadataCache.getFileCache(file)
    const fm = meta?.frontmatter as Record<string, unknown> | undefined
    if (!fm || fm[PROJECT_KEY] !== true) return

    const known = new Set([
      PROJECT_KEY,
      'id',
      'title',
      'color',
      'icon',
      'projects',
      'statuses',
      'priorities',
      'fields',
      'teamMembers',
      'defaultView',
      'autoSchedule',
      'pullForwardOnEarlyFinish',
      'autoArchiveDays',
      'gh-repos',
      'position'
    ])

    const unknown: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(fm)) {
      if (!known.has(key)) unknown[key] = value
    }

    this.byPath.set(file.path, {
      id: typeof fm.id === 'string' ? fm.id : file.path,
      path: file.path,
      title: typeof fm.title === 'string' && fm.title ? fm.title : file.basename,
      color: typeof fm.color === 'string' ? fm.color : undefined,
      icon: typeof fm.icon === 'string' ? fm.icon : undefined,
      statuses: parseStatuses(fm.statuses),
      priorities: parsePriorities(fm.priorities),
      fields: parseFields(fm.fields),
      teamMembers: stringList(fm.teamMembers),
      defaultView: parseViewMode(fm.defaultView),
      autoSchedule: typeof fm.autoSchedule === 'boolean' ? fm.autoSchedule : undefined,
      pullForwardOnEarlyFinish:
        typeof fm.pullForwardOnEarlyFinish === 'boolean'
          ? fm.pullForwardOnEarlyFinish
          : undefined,
      autoArchiveDays:
        typeof fm.autoArchiveDays === 'number' ? fm.autoArchiveDays : undefined,
      ghRepos: stringList(fm['gh-repos']),
      unknown
    })
  }

  /** A project nests by pointing its own `projects` link at another project note. */
  private resolveParent(project: Project): string | undefined {
    const file = this.app.vault.getAbstractFileByPath(project.path)
    if (!(file instanceof ObsidianTFile)) return undefined
    const refs = stringList(
      this.app.metadataCache.getFileCache(file)?.frontmatter?.projects
    )
    for (const ref of refs) {
      const { target } = parseLink(ref)
      const dest = this.app.metadataCache.getFirstLinkpathDest(
        stripExtension(target),
        project.path
      )
      if (dest && this.byPath.has(dest.path)) return dest.path
    }
    return undefined
  }
}

/** Nearest declaration of a key wins; fields from further up are kept. */
function mergeFields(chain: Project[], globalFields: CustomFieldDef[]): CustomFieldDef[] {
  const out: CustomFieldDef[] = []
  const seen = new Set<string>()
  for (const project of chain) {
    for (const field of project.fields ?? []) {
      if (seen.has(field.key)) continue
      seen.add(field.key)
      out.push(field)
    }
  }
  for (const field of globalFields) {
    if (seen.has(field.key)) continue
    seen.add(field.key)
    out.push(field)
  }
  return out
}

function stringList(value: unknown): string[] {
  if (value === undefined || value === null) return []
  const raw = Array.isArray(value) ? value : [value]
  return raw.map((v) => String(v).trim()).filter(Boolean)
}

function parseViewMode(value: unknown): ViewMode | undefined {
  const modes: ViewMode[] = ['table', 'gantt', 'kanban', 'calendar']
  return typeof value === 'string' && (modes as string[]).includes(value)
    ? (value as ViewMode)
    : undefined
}

function parseStatuses(value: unknown): StatusConfig[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: StatusConfig[] = []
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue
    const item = raw as Record<string, unknown>
    const id = typeof item.id === 'string' ? item.id : undefined
    if (!id) continue
    out.push({
      id,
      label: typeof item.label === 'string' ? item.label : id,
      color: typeof item.color === 'string' ? item.color : '#8b8b8b',
      icon: typeof item.icon === 'string' ? item.icon : 'circle',
      complete: item.complete === true,
      skipWhenCycling: item.skipWhenCycling === true
    })
  }
  return out.length ? out : undefined
}

function parsePriorities(value: unknown): PriorityConfig[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: PriorityConfig[] = []
  for (const [index, raw] of value.entries()) {
    if (typeof raw !== 'object' || raw === null) continue
    const item = raw as Record<string, unknown>
    const id = typeof item.id === 'string' ? item.id : undefined
    if (!id) continue
    out.push({
      id,
      label: typeof item.label === 'string' ? item.label : id,
      color: typeof item.color === 'string' ? item.color : '#8b8b8b',
      icon: typeof item.icon === 'string' ? item.icon : 'equal',
      weight: typeof item.weight === 'number' ? item.weight : (value.length - index) * 10
    })
  }
  return out.length ? out : undefined
}

function parseFields(value: unknown): CustomFieldDef[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: CustomFieldDef[] = []
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue
    const item = raw as Record<string, unknown>
    const key = typeof item.key === 'string' ? item.key : undefined
    if (!key) continue
    out.push({
      key,
      label: typeof item.label === 'string' ? item.label : key,
      type: (typeof item.type === 'string' ? item.type : 'text') as CustomFieldDef['type'],
      options: Array.isArray(item.options) ? item.options.map(String) : undefined,
      icon: typeof item.icon === 'string' ? item.icon : undefined
    })
  }
  return out.length ? out : undefined
}
