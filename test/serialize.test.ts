import { describe, expect, it } from 'vitest'
import { parseTask, serializeTask } from '../src/store/serialize'

const ctx = {
  path: 'Tareas/demo.md',
  basename: 'demo',
  generateId: () => 'generated-id'
}

describe('parseTask', () => {
  it('keeps every key it does not own so writes can put them back', () => {
    const { task } = parseTask(
      { title: 'A', status: 'open', 'pm-task': true, cliente: 'ACME' },
      ctx
    )
    expect(task.unknown).toEqual({ 'pm-task': true, cliente: 'ACME' })

    const out = serializeTask(task)
    expect(out['pm-task']).toBe(true)
    expect(out.cliente).toBe('ACME')
  })

  it('lets the canonical key win over an alias, per spec 2.4.2', () => {
    const { task } = parseTask(
      { title: 'A', status: 'open', scheduled: '2026-03-01', start: '2020-01-01' },
      ctx
    )
    expect(task.scheduled).toBe('2026-03-01')
  })

  it('reads Project Manager start dates when scheduled is absent', () => {
    const { task } = parseTask({ title: 'A', status: 'open', start: '2026-03-01' }, ctx)
    expect(task.scheduled).toBe('2026-03-01')
  })

  it('reports the conflict rather than silently merging', () => {
    const { issues } = parseTask(
      { title: 'A', status: 'open', scheduled: '2026-03-01', start: '2020-01-01' },
      ctx
    )
    expect(issues).toEqual([
      {
        code: 'alias_conflict_ignored',
        role: 'scheduled',
        canonicalKey: 'scheduled',
        aliasKey: 'start'
      }
    ])
  })

  it('falls back to the filename when no title role is present', () => {
    const { task } = parseTask({ status: 'open' }, ctx)
    expect(task.title).toBe('demo')
  })

  it('normalizes a bare dependency string into a record', () => {
    const { task } = parseTask({ status: 'open', blockedBy: '[[otra]]' }, ctx)
    expect(task.blockedBy).toEqual([{ uid: '[[otra]]', reltype: 'FINISHTOSTART' }])
  })

  it('rebuilds Project Manager time logs as intervals', () => {
    const { task } = parseTask(
      { status: 'open', timeLogs: [{ date: '2026-03-01', hours: 2, note: 'revisión' }] },
      ctx
    )
    expect(task.timeEntries).toHaveLength(1)
    const entry = task.timeEntries[0]!
    expect(entry.description).toBe('revisión')
    const minutes =
      (new Date(entry.endTime!).getTime() - new Date(entry.startTime).getTime()) / 60000
    expect(minutes).toBe(120)
  })

  it('closes all but the newest running timer, per spec 2.6.1', () => {
    const { task } = parseTask(
      {
        status: 'open',
        timeEntries: [
          { startTime: '2026-03-01T09:00:00Z' },
          { startTime: '2026-03-02T09:00:00Z' }
        ]
      },
      ctx
    )
    expect(task.timeEntries.filter((e) => !e.endTime)).toHaveLength(1)
    expect(task.timeEntries[1]!.endTime).toBeUndefined()
  })

  it('normalizes a scalar attachment into a list, per spec 2.6.7', () => {
    const { task } = parseTask({ status: 'open', attachments: '[[a.pdf]]' }, ctx)
    expect(task.attachments).toEqual(['[[a.pdf]]'])
  })
})

describe('serializeTask', () => {
  it('drops empty values instead of writing null', () => {
    const { task } = parseTask({ title: 'A', status: 'open' }, ctx)
    const out = serializeTask(task)
    expect('due' in out).toBe(false)
    expect('tags' in out).toBe(false)
    expect('priority' in out).toBe(false)
  })

  it('round-trips without losing or inventing fields', () => {
    const input = {
      id: 'demo-1',
      title: 'Revisar dietas',
      status: 'in-progress',
      priority: 'high',
      scheduled: '2026-09-01',
      due: '2026-09-15',
      projects: ['[[Dietas]]'],
      tags: ['q3'],
      progress: 60,
      assignees: ['Carlos'],
      timeEstimate: 90,
      blockedBy: [{ uid: 'otra-1', reltype: 'FINISHTOSTART', gap: 'P1D' }],
      dateCreated: '2026-08-01T10:00:00Z',
      dateModified: '2026-08-02T10:00:00Z',
      'gh-issue': 'org/repo#412',
      cliente: 'ACME'
    }
    const { task } = parseTask(input, ctx)
    expect(serializeTask(task)).toEqual(input)
  })

  it('only stamps a completion date when the status says so', () => {
    const { task } = parseTask({ status: 'done', completedDate: '2026-08-01' }, ctx)
    expect(serializeTask(task).completedDate).toBe('2026-08-01')
  })
})
