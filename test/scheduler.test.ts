import { describe, expect, it } from 'vitest'
import { reschedule } from '../src/store/scheduler'
import type { Dependency, Task } from '../src/types'

function task(
  path: string,
  scheduled: string | undefined,
  due: string | undefined,
  blockedBy: Dependency[] = []
): Task {
  return {
    id: path,
    path,
    title: path,
    status: 'open',
    dateCreated: '2026-01-01T00:00:00Z',
    dateModified: '2026-01-01T00:00:00Z',
    scheduled,
    due,
    tags: [],
    contexts: [],
    projects: [],
    attachments: [],
    timeEntries: [],
    blockedBy,
    reminders: [],
    completeInstances: [],
    skippedInstances: [],
    assignees: [],
    customFields: {},
    unknown: {},
    archived: false
  }
}

/** Resolves a dependency uid straight to the task whose path equals it. */
const resolve = (tasks: Task[]) => (uid: string) => tasks.find((t) => t.path === uid)

describe('reschedule', () => {
  it('pushes a dependent that starts before its blocker finishes', () => {
    const blocker = task('a', '2026-03-01', '2026-03-10')
    const dependent = task('b', '2026-03-05', '2026-03-08', [
      { uid: 'a', reltype: 'FINISHTOSTART' }
    ])
    const tasks = [blocker, dependent]

    const result = reschedule(tasks, resolve(tasks), 'a')
    expect(result.cycle).toEqual([])
    expect(result.changes).toEqual([
      { path: 'b', scheduled: '2026-03-11', due: '2026-03-14' }
    ])
  })

  it('preserves the dependent duration when it moves', () => {
    const tasks = [
      task('a', '2026-03-01', '2026-03-10'),
      task('b', '2026-03-02', '2026-03-12', [{ uid: 'a', reltype: 'FINISHTOSTART' }])
    ]
    const change = reschedule(tasks, resolve(tasks), 'a').changes[0]!
    const days =
      (Date.parse(change.due!) - Date.parse(change.scheduled!)) / 86_400_000
    expect(days).toBe(10)
  })

  it('honours the gap', () => {
    const tasks = [
      task('a', '2026-03-01', '2026-03-10'),
      task('b', '2026-03-05', '2026-03-06', [
        { uid: 'a', reltype: 'FINISHTOSTART', gap: 'P3D' }
      ])
    ]
    expect(reschedule(tasks, resolve(tasks), 'a').changes[0]!.scheduled).toBe('2026-03-14')
  })

  it('leaves a dependent that already has slack alone', () => {
    const tasks = [
      task('a', '2026-03-01', '2026-03-10'),
      task('b', '2026-04-01', '2026-04-05', [{ uid: 'a', reltype: 'FINISHTOSTART' }])
    ]
    expect(reschedule(tasks, resolve(tasks), 'a').changes).toEqual([])
  })

  it('anchors a start-to-start dependency on the blocker start', () => {
    const tasks = [
      task('a', '2026-03-10', '2026-03-20'),
      task('b', '2026-03-01', '2026-03-05', [{ uid: 'a', reltype: 'STARTTOSTART' }])
    ]
    expect(reschedule(tasks, resolve(tasks), 'a').changes[0]!.scheduled).toBe('2026-03-11')
  })

  it('propagates down a chain in one pass', () => {
    const tasks = [
      task('a', '2026-03-01', '2026-03-10'),
      task('b', '2026-03-02', '2026-03-04', [{ uid: 'a', reltype: 'FINISHTOSTART' }]),
      task('c', '2026-03-03', '2026-03-05', [{ uid: 'b', reltype: 'FINISHTOSTART' }])
    ]
    const changes = reschedule(tasks, resolve(tasks), 'a').changes
    expect(changes.map((c) => c.path)).toEqual(['b', 'c'])
    expect(changes[1]!.scheduled! > changes[0]!.due!).toBe(true)
  })

  it('refuses a cycle instead of applying half of it', () => {
    const tasks = [
      task('a', '2026-03-01', '2026-03-10', [{ uid: 'b', reltype: 'FINISHTOSTART' }]),
      task('b', '2026-03-01', '2026-03-10', [{ uid: 'a', reltype: 'FINISHTOSTART' }])
    ]
    const result = reschedule(tasks, resolve(tasks), 'a')
    expect(result.changes).toEqual([])
    expect(result.cycle.length).toBeGreaterThan(0)
  })

  it('ignores dependencies that point at nothing', () => {
    const tasks = [
      task('b', '2026-03-05', '2026-03-08', [{ uid: 'fantasma', reltype: 'FINISHTOSTART' }])
    ]
    expect(reschedule(tasks, resolve(tasks), 'x').changes).toEqual([])
  })
})
