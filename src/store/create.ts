import type { App, TFile } from 'obsidian'
import { normalizePath } from 'obsidian'
import type { ProjectNotesSettings } from '../settings'
import type { Task } from '../types'
import { serializeTask } from './serialize'

export interface NewTaskInput {
  title?: string
  status?: string
  priority?: string
  scheduled?: string
  due?: string
  projects?: string[]
  body?: string
}

/**
 * Creates the task note. The frontmatter is written as text rather than through
 * `processFrontMatter` because the file does not exist yet, and creating an empty note
 * only to patch it produces two entries in the vault's change log for one task.
 */
export async function createTask(
  app: App,
  settings: ProjectNotesSettings,
  input: NewTaskInput
): Promise<TFile> {
  const now = new Date().toISOString()
  const title = input.title?.trim() || 'Tarea sin título'
  const firstStatus = settings.statuses[0]?.id ?? 'open'

  const task: Task = {
    id: '',
    path: '',
    title,
    status: input.status ?? firstStatus,
    dateCreated: now,
    dateModified: now,
    priority: input.priority,
    scheduled: input.scheduled,
    due: input.due,
    tags: [],
    contexts: [],
    projects: input.projects ?? [],
    attachments: [],
    timeEntries: [],
    blockedBy: [],
    reminders: [],
    completeInstances: [],
    skippedInstances: [],
    assignees: [],
    customFields: {},
    unknown: {},
    archived: false
  }
  task.id = makeId(title)

  const frontmatter = serializeTask(task)
  const identification = settings.identification
  if (identification.mode === 'property') {
    frontmatter[identification.key] = coerce(identification.value ?? 'true')
  } else {
    frontmatter.tags = [identification.key]
  }

  const folder = normalizePath(settings.tasksFolder)
  await ensureFolder(app, folder)
  const path = await uniquePath(app, `${folder}/${sanitize(title)}.md`)

  const contents = `---\n${toYaml(frontmatter)}---\n\n${input.body ?? ''}`
  return app.vault.create(path, contents)
}

function coerce(value: string): unknown {
  if (value === 'true') return true
  if (value === 'false') return false
  const asNumber = Number(value)
  return Number.isFinite(asNumber) && value.trim() !== '' ? asNumber : value
}

async function ensureFolder(app: App, folder: string): Promise<void> {
  if (!folder || app.vault.getAbstractFileByPath(folder)) return
  const parts = folder.split('/')
  let current = ''
  for (const part of parts) {
    current = current ? `${current}/${part}` : part
    if (!app.vault.getAbstractFileByPath(current)) {
      await app.vault.createFolder(current)
    }
  }
}

async function uniquePath(app: App, desired: string): Promise<string> {
  if (!app.vault.getAbstractFileByPath(desired)) return desired
  const base = desired.slice(0, -3)
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base} ${i}.md`
    if (!app.vault.getAbstractFileByPath(candidate)) return candidate
  }
  return `${base} ${Date.now()}.md`
}

/** Obsidian rejects these in filenames; the title keeps them. */
function sanitize(title: string): string {
  return title.replace(/[\\/:*?"<>|#^[\]]/g, '').trim() || 'tarea'
}

function makeId(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
  return `${slug || 'task'}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Minimal YAML writer for the frontmatter we generate ourselves. It only has to handle
 * the shapes `serializeTask` produces — scalars, string lists and lists of flat objects.
 */
function toYaml(value: Record<string, unknown>, indent = ''): string {
  let out = ''
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue
    if (Array.isArray(item)) {
      if (item.length === 0) continue
      out += `${indent}${key}:\n`
      for (const entry of item) {
        if (entry !== null && typeof entry === 'object') {
          const lines = toYaml(entry as Record<string, unknown>, `${indent}    `)
          out += `${indent}  - ${lines.trimStart()}`
        } else {
          out += `${indent}  - ${scalar(entry)}\n`
        }
      }
    } else if (item !== null && typeof item === 'object') {
      out += `${indent}${key}:\n${toYaml(item as Record<string, unknown>, `${indent}  `)}`
    } else {
      out += `${indent}${key}: ${scalar(item)}\n`
    }
  }
  return out
}

function scalar(value: unknown): string {
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  const text = String(value)
  // Quote anything YAML would otherwise reinterpret — wikilinks most of all, since
  // `[[X]]` unquoted parses as a nested empty sequence.
  return /^[\w.@/ -]+$/.test(text) && !/^\d{4}-\d{2}-\d{2}/.test(text)
    ? text
    : JSON.stringify(text)
}
