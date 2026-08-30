import { describe, expect, it } from 'vitest'
import {
  addManualEntry,
  elapsedMs,
  formatDuration,
  isRunning,
  removeEntry,
  runningEntry,
  startTimer,
  stopTimer,
  trackedMinutes,
  trackedMinutesOn,
  updateEntry
} from '../src/store/timer'
import type { Task, TimeEntry } from '../src/types'

function task(entries: TimeEntry[] = []): Task {
  return {
    id: 'demo',
    path: 'Tareas/demo.md',
    title: 'Revisar dietas',
    status: 'open',
    dateCreated: '2026-01-01T00:00:00Z',
    dateModified: '2026-01-01T00:00:00Z',
    tags: [],
    contexts: [],
    projects: [],
    attachments: [],
    timeEntries: entries,
    blockedBy: [],
    reminders: [],
    completeInstances: [],
    skippedInstances: [],
    assignees: [],
    customFields: {},
    unknown: {},
    archived: false
  }
}

describe('startTimer', () => {
  it('opens a session with no end time', () => {
    const patch = startTimer(task(), undefined, new Date('2026-09-01T09:00:00Z'))
    expect(patch?.timeEntries).toEqual([{ startTime: '2026-09-01T09:00:00.000Z' }])
  })

  it('refuses to open a second session on the same task', () => {
    // Two open entries would make the task invalid per spec 2.6.1, and a double click
    // on play is the easiest way to get there.
    const running = task([{ startTime: '2026-09-01T09:00:00.000Z' }])
    expect(startTimer(running)).toBeNull()
  })

  it('keeps the optional description', () => {
    const patch = startTimer(task(), 'llamada', new Date('2026-09-01T09:00:00Z'))
    expect(patch?.timeEntries?.[0]?.description).toBe('llamada')
  })
})

describe('stopTimer', () => {
  it('closes the running session', () => {
    const running = task([{ startTime: '2026-09-01T09:00:00.000Z' }])
    const patch = stopTimer(running, new Date('2026-09-01T10:30:00Z'))
    expect(patch?.timeEntries?.[0]?.endTime).toBe('2026-09-01T10:30:00.000Z')
  })

  it('drops a mis-click instead of logging a zero-length session', () => {
    const running = task([{ startTime: '2026-09-01T09:00:00.000Z' }])
    const patch = stopTimer(running, new Date('2026-09-01T09:00:00.400Z'))
    expect(patch?.timeEntries).toEqual([])
  })

  it('is a no-op when nothing is running', () => {
    expect(stopTimer(task([{ startTime: 'x', endTime: 'y' }]))).toBeNull()
  })

  it('leaves other sessions untouched', () => {
    const t = task([
      { startTime: '2026-08-31T09:00:00.000Z', endTime: '2026-08-31T10:00:00.000Z' },
      { startTime: '2026-09-01T09:00:00.000Z' }
    ])
    const patch = stopTimer(t, new Date('2026-09-01T09:30:00Z'))
    expect(patch?.timeEntries?.[0]?.endTime).toBe('2026-08-31T10:00:00.000Z')
    expect(patch?.timeEntries).toHaveLength(2)
  })
})

describe('start/stop round trip', () => {
  it('accumulates across sessions', () => {
    let t = task()
    t = { ...t, ...startTimer(t, undefined, new Date('2026-09-01T09:00:00Z')) }
    t = { ...t, ...stopTimer(t, new Date('2026-09-01T10:00:00Z')) }
    t = { ...t, ...startTimer(t, undefined, new Date('2026-09-01T14:00:00Z')) }
    t = { ...t, ...stopTimer(t, new Date('2026-09-01T14:30:00Z')) }

    expect(isRunning(t)).toBe(false)
    expect(trackedMinutes(t)).toBe(90)
  })
})

describe('elapsed and totals', () => {
  it('counts the open session up to now', () => {
    const t = task([{ startTime: '2026-09-01T09:00:00.000Z' }])
    const now = Date.parse('2026-09-01T09:45:00Z')
    expect(elapsedMs(t, now)).toBe(45 * 60_000)
    expect(trackedMinutes(t, now)).toBe(45)
  })

  it('returns zero elapsed when stopped', () => {
    const t = task([
      { startTime: '2026-09-01T09:00:00.000Z', endTime: '2026-09-01T10:00:00.000Z' }
    ])
    expect(elapsedMs(t)).toBe(0)
    expect(trackedMinutes(t)).toBe(60)
  })

  it('ignores entries with unparseable or reversed times', () => {
    const t = task([
      { startTime: 'no es una fecha', endTime: '2026-09-01T10:00:00.000Z' },
      { startTime: '2026-09-01T12:00:00.000Z', endTime: '2026-09-01T11:00:00.000Z' },
      { startTime: '2026-09-01T09:00:00.000Z', endTime: '2026-09-01T09:30:00.000Z' }
    ])
    expect(trackedMinutes(t)).toBe(30)
  })

  it('totals one calendar day', () => {
    const t = task([
      { startTime: '2026-09-01T09:00:00.000Z', endTime: '2026-09-01T10:00:00.000Z' },
      { startTime: '2026-09-02T09:00:00.000Z', endTime: '2026-09-02T11:00:00.000Z' }
    ])
    expect(trackedMinutesOn(t, '2026-09-01')).toBe(60)
    expect(trackedMinutesOn(t, '2026-09-02')).toBe(120)
  })
})

describe('entry editing', () => {
  it('removes one session by index', () => {
    const t = task([{ startTime: 'a' }, { startTime: 'b' }])
    expect(removeEntry(t, 0).timeEntries).toEqual([{ startTime: 'b' }])
  })

  it('patches a description without touching the times', () => {
    const t = task([
      { startTime: '2026-09-01T09:00:00.000Z', endTime: '2026-09-01T10:00:00.000Z' }
    ])
    const patch = updateEntry(t, 0, { description: 'revisión' })
    expect(patch.timeEntries?.[0]).toEqual({
      startTime: '2026-09-01T09:00:00.000Z',
      endTime: '2026-09-01T10:00:00.000Z',
      description: 'revisión'
    })
  })

  it('adds a closed manual session of the right length', () => {
    const patch = addManualEntry(task(), '2026-09-01', 90, 'reunión')
    const entry = patch.timeEntries?.[0] as TimeEntry
    const minutes =
      (Date.parse(entry.endTime as string) - Date.parse(entry.startTime)) / 60_000
    expect(minutes).toBe(90)
    expect(runningEntry({ ...task(), ...patch })).toBeUndefined()
  })
})

describe('formatDuration', () => {
  it('formats for the log and for the live clock', () => {
    expect(formatDuration(45 * 60_000)).toBe('45m')
    expect(formatDuration(90 * 60_000)).toBe('1h 30m')
    expect(formatDuration(90_000, true)).toBe('01:30')
    expect(formatDuration(3_690_000, true)).toBe('1:01:30')
  })
})
