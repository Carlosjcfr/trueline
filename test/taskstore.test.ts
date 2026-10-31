import { beforeEach, describe, expect, it } from 'vitest'
import type { App, CachedMetadata } from 'obsidian'
import { TaskStore, type TaskIdentification } from '../src/store/TaskStore'
import { createTask } from '../src/store/create'
import { defaultSettings } from '../src/settings'
import { FakeVault } from './helpers/fakeVault'

const DEFAULT_ID: TaskIdentification = { mode: 'property', key: 'tl-task', value: 'true' }

function setup(identification: TaskIdentification = DEFAULT_ID) {
  const vault = new FakeVault()
  const store = new TaskStore(vault.app as unknown as App, {
    identification,
    tasksFolder: 'Tareas'
  })
  let events = 0
  store.subscribe(() => events++)
  return {
    vault,
    store,
    events: () => events,
    /** Delivers the metadata event Obsidian sends after a file changes. */
    deliver: (path: string) =>
      store.onFileChanged(
        vault.file(path),
        '',
        vault.cacheFor(path) as unknown as CachedMetadata
      )
  }
}

describe('bug 4: our own writes and no-op changes', () => {
  let t: ReturnType<typeof setup>

  beforeEach(() => {
    t = setup()
    t.vault.add('Tareas/a.md', { 'tl-task': true, id: 'a-1', title: 'A', status: 'open' })
    t.store.rebuild()
  })

  it('ignores the echo of its own write', () => {
    const before = t.events()
    return t.store.update('Tareas/a.md', { title: 'A renombrada' }).then(() => {
      expect(t.events()).toBe(before + 1) // the write itself
      t.deliver('Tareas/a.md') // the metadata event Obsidian sends afterwards
      expect(t.events()).toBe(before + 1) // ...is recognised and ignored
      expect(t.store.get('Tareas/a.md')?.title).toBe('A renombrada')
    })
  })

  it('stays quiet when only the body changed', () => {
    // Every autosave while typing in a task note arrives as a metadata event.
    // Before this fix each one repainted every open view.
    const before = t.events()
    t.vault.edit('Tareas/a.md', () => {}, 'notas nuevas en el cuerpo')
    t.deliver('Tareas/a.md')
    expect(t.events()).toBe(before)
  })

  it('still reports a real change made outside the plugin', () => {
    const before = t.events()
    t.vault.edit('Tareas/a.md', (fm) => {
      fm.status = 'done'
    })
    t.deliver('Tareas/a.md')
    expect(t.events()).toBe(before + 1)
    expect(t.store.get('Tareas/a.md')?.status).toBe('done')
  })

  it('is not fooled by key order', () => {
    const before = t.events()
    t.vault.edit('Tareas/a.md', (fm) => {
      const copy = { ...fm }
      for (const key of Object.keys(fm)) delete fm[key]
      for (const key of Object.keys(copy).reverse()) fm[key] = copy[key]
    })
    t.deliver('Tareas/a.md')
    expect(t.events()).toBe(before)
  })

  it('reports a note that stops being a task', () => {
    const before = t.events()
    t.vault.edit('Tareas/a.md', (fm) => {
      delete fm['tl-task']
    })
    t.deliver('Tareas/a.md')
    expect(t.events()).toBe(before + 1)
    expect(t.store.get('Tareas/a.md')).toBeUndefined()
    expect(t.store.getById('a-1')).toBeUndefined()
  })
})

describe('bug 4: notes with no id or dates in their frontmatter', () => {
  it('keeps the same invented id across re-parses and re-scans', () => {
    const t = setup()
    t.vault.add('Tareas/sin-id.md', { 'tl-task': true, title: 'Sin id' })
    t.store.rebuild()
    const id = t.store.get('Tareas/sin-id.md')?.id
    expect(id).toBeTruthy()

    t.deliver('Tareas/sin-id.md')
    expect(t.store.get('Tareas/sin-id.md')?.id).toBe(id)

    t.store.rebuild()
    expect(t.store.get('Tareas/sin-id.md')?.id).toBe(id)
    expect(t.store.getById(id as string)?.path).toBe('Tareas/sin-id.md')
  })

  it('does not treat a re-parse as a change because the dates were invented again', () => {
    const t = setup()
    t.vault.add('Tareas/sin-fechas.md', { 'tl-task': true, title: 'Sin fechas' })
    t.store.rebuild()
    const created = t.store.get('Tareas/sin-fechas.md')?.dateCreated
    const before = t.events()

    t.deliver('Tareas/sin-fechas.md')
    expect(t.events()).toBe(before)
    expect(t.store.get('Tareas/sin-fechas.md')?.dateCreated).toBe(created)
  })
})

describe('bug 2: changing how tasks are identified', () => {
  it('re-indexes the vault when the identification changes', () => {
    const t = setup()
    t.vault.add('PM/b.md', { 'pm-task': true, title: 'De Project Manager' })
    t.store.rebuild()
    expect(t.store.get('PM/b.md')).toBeUndefined()

    t.store.setOptions({ identification: { mode: 'property', key: 'pm-task', value: 'true' } })
    expect(t.store.get('PM/b.md')?.title).toBe('De Project Manager')
  })

  it('drops notes the new identification no longer matches', () => {
    const t = setup()
    t.vault.add('Tareas/a.md', { 'tl-task': true, title: 'A' })
    t.store.rebuild()
    t.store.setOptions({ identification: { mode: 'property', key: 'pm-task', value: 'true' } })
    expect(t.store.get('Tareas/a.md')).toBeUndefined()
  })

  it('emits once, so open views repaint with the new set', () => {
    const t = setup()
    const before = t.events()
    t.store.setOptions({ identification: { mode: 'tag', key: 'task' } })
    expect(t.events()).toBe(before + 1)
  })

  it('cannot be changed by mutating the settings object behind its back', () => {
    // It used to hold the settings object itself, so an edit half-applied: new notes
    // were judged by the new key while the indexed ones kept the old verdict.
    const identification = { ...DEFAULT_ID }
    const t = setup(identification)
    t.vault.add('PM/b.md', { 'pm-task': true, title: 'B' })
    identification.key = 'pm-task'
    t.store.rebuild()
    expect(t.store.get('PM/b.md')).toBeUndefined()
  })

  it('treats an empty expected value as "any value"', () => {
    const t = setup({ mode: 'property', key: 'tl-task', value: '' })
    t.vault.add('Tareas/c.md', { 'tl-task': 'yes', title: 'C' })
    t.store.rebuild()
    expect(t.store.get('Tareas/c.md')).toBeDefined()
  })

  it('still recognises notes written before the rename to Trueline', () => {
    const t = setup()
    t.vault.add('Tareas/vieja.md', { 'pn-task': true, title: 'Vieja' })
    t.store.rebuild()
    expect(t.store.get('Tareas/vieja.md')?.title).toBe('Vieja')
  })
})

describe('creating a task', () => {
  it('writes gh-issue with the note itself, in valid YAML', async () => {
    // Linking in a second write left an unlinked note behind whenever that write
    // failed, and the next sync imported the same issue again.
    const vault = new FakeVault()
    const file = await createTask(vault.app as unknown as App, defaultSettings(), {
      title: 'Issue importado',
      ghIssue: 'org/repo#412'
    })
    const fm = vault.frontmatter(file.path)
    expect(fm['gh-issue']).toBe('org/repo#412')
    expect(fm['tl-task']).toBe(true)
    expect(fm.title).toBe('Issue importado')
  })
})
