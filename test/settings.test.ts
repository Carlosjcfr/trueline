import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, SETTINGS_VERSION, loadSettingsFrom } from '../src/settings'

/** A data.json as v0.1 wrote it: no `settingsVersion`, no `github.mapping`. */
const V01_DATA = {
  identification: { mode: 'property', key: 'tl-task', value: 'true' },
  tasksFolder: 'Mis/Tareas',
  github: { enabled: true, token: 'ghp_x', repos: ['org/repo'], pollSeconds: 60 }
}

describe('bug 1: loading settings', () => {
  it('fills nested settings that did not exist when data.json was written', () => {
    // This is the exact shape that made the settings tab throw
    // "Cannot read properties of undefined (reading 'closedStatuses')".
    const settings = loadSettingsFrom(V01_DATA)
    expect(settings.github.mapping.closedStatuses).toEqual(['done', 'cancelled'])
    expect(settings.github.lastPolled).toEqual({})
    expect(settings.github.direction).toBe('both')
  })

  it('keeps every value the user had saved', () => {
    const settings = loadSettingsFrom(V01_DATA)
    expect(settings.tasksFolder).toBe('Mis/Tareas')
    expect(settings.github.enabled).toBe(true)
    expect(settings.github.token).toBe('ghp_x')
    expect(settings.github.repos).toEqual(['org/repo'])
  })

  it('never lets an edit leak back into the defaults', () => {
    const first = loadSettingsFrom(undefined)
    first.statuses.push({ id: 'x', label: 'x', color: '', icon: '', complete: false })
    first.github.mapping.closedStatuses.push('x')
    first.github.lastPolled['org/repo'] = '2026-01-01T00:00:00Z'

    const second = loadSettingsFrom(undefined)
    expect(second.statuses).toHaveLength(DEFAULT_SETTINGS.statuses.length)
    expect(second.github.mapping.closedStatuses).toEqual(['done', 'cancelled'])
    expect(second.github.lastPolled).toEqual({})
    expect(DEFAULT_SETTINGS.statuses.some((s) => s.id === 'x')).toBe(false)
  })

  it('replaces lists whole instead of interleaving them with the defaults', () => {
    const settings = loadSettingsFrom({
      statuses: [{ id: 'todo', label: 'To do', color: '#000', icon: 'circle', complete: false }]
    })
    expect(settings.statuses.map((s) => s.id)).toEqual(['todo'])
  })

  it('ignores a saved value of the wrong type rather than breaking on it', () => {
    const settings = loadSettingsFrom({
      autoArchiveDays: 'catorce',
      statuses: 'none',
      github: 'not an object'
    })
    expect(settings.autoArchiveDays).toBe(0)
    expect(settings.statuses).toHaveLength(DEFAULT_SETTINGS.statuses.length)
    expect(settings.github.mapping).toBeDefined()
  })

  it('keeps keys it does not know, so a newer version survives an older one', () => {
    const settings = loadSettingsFrom({ futureSetting: 42, github: { futureNested: true } })
    expect((settings as unknown as Record<string, unknown>).futureSetting).toBe(42)
    expect((settings.github as unknown as Record<string, unknown>).futureNested).toBe(true)
  })

  it('keeps an empty identification value instead of restoring the default', () => {
    // '' means "accept any value". Stored as undefined it would vanish from JSON and
    // come back as 'true' on the next launch.
    const settings = loadSettingsFrom({ identification: { mode: 'property', key: 'x', value: '' } })
    expect(settings.identification.value).toBe('')
  })

  it('stamps the current version', () => {
    expect(loadSettingsFrom(V01_DATA).settingsVersion).toBe(SETTINGS_VERSION)
  })

  it('falls back to defaults for anything that is not a settings object', () => {
    for (const junk of [null, undefined, [], 'x', 3]) {
      expect(loadSettingsFrom(junk).github.mapping).toBeDefined()
    }
  })
})
