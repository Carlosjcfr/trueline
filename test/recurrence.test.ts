import { describe, expect, it } from 'vitest'
import {
  completeInstance,
  describeRecurrence,
  ensureDtstart,
  instanceState,
  nextOccurrence,
  occurrencesBetween,
  parseRecurrence,
  skipInstance,
  uncompleteInstance,
  withDtstart
} from '../src/recurrence'
import { toDay } from '../src/dates'
import type { Task } from '../src/types'

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'demo',
    path: 'Tareas/demo.md',
    title: 'Revisión semanal',
    status: 'open',
    dateCreated: '2026-02-01T00:00:00Z',
    dateModified: '2026-02-01T00:00:00Z',
    tags: [],
    contexts: [],
    projects: [],
    attachments: [],
    timeEntries: [],
    blockedBy: [],
    reminders: [],
    completeInstances: [],
    skippedInstances: [],
    assignees: [],
    customFields: {},
    unknown: {},
    archived: false,
    ...overrides
  }
}

const day = (iso: string): number => toDay(iso) as number

describe('parseRecurrence', () => {
  it('parses the combined single-line DTSTART form correctly', () => {
    // rrulestr mis-parses this form without throwing, turning a weekly rule into a
    // yearly one. This test exists to pin that exact failure.
    const { rule } = parseRecurrence('DTSTART:20260220;FREQ=WEEKLY;BYDAY=FR')
    const dates = rule.all((_, index) => index < 4).map((d) => d.toISOString().slice(0, 10))
    expect(dates).toEqual(['2026-02-20', '2026-02-27', '2026-03-06', '2026-03-13'])
  })

  it('accepts a UTC datetime DTSTART', () => {
    const { rule, hadDtstart } = parseRecurrence('DTSTART:20260220T090000Z;FREQ=DAILY')
    expect(hadDtstart).toBe(true)
    expect(rule.options.dtstart.toISOString()).toBe('2026-02-20T09:00:00.000Z')
  })

  it('tolerates a leading RRULE: prefix', () => {
    expect(() => parseRecurrence('RRULE:FREQ=DAILY', task())).not.toThrow()
  })

  it('seeds from scheduled, then from dateCreated', () => {
    const fromScheduled = parseRecurrence('FREQ=DAILY', task({ scheduled: '2026-03-10' }))
    expect(fromScheduled.rule.options.dtstart.toISOString().slice(0, 10)).toBe('2026-03-10')

    const fromCreated = parseRecurrence('FREQ=DAILY', task())
    expect(fromCreated.rule.options.dtstart.toISOString().slice(0, 10)).toBe('2026-02-01')
  })

  it('rejects an empty or malformed rule instead of guessing', () => {
    expect(() => parseRecurrence('', task())).toThrow()
    expect(() => parseRecurrence('DTSTART:20260220', task())).toThrow()
  })
})

describe('occurrencesBetween', () => {
  it('expands a weekly rule inside the window', () => {
    const t = task({ recurrence: 'DTSTART:20260907;FREQ=WEEKLY;BYDAY=MO' })
    const dates = occurrencesBetween(t, day('2026-09-01'), day('2026-09-30')).map((o) => o.date)
    expect(dates).toEqual(['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28'])
  })

  it('resolves instance state in the order the spec fixes', () => {
    const t = task({
      recurrence: 'DTSTART:20260907;FREQ=WEEKLY;BYDAY=MO',
      completeInstances: ['2026-09-14'],
      skippedInstances: ['2026-09-21']
    })
    const states = occurrencesBetween(t, day('2026-09-01'), day('2026-09-30'))
    expect(states.map((o) => o.state)).toEqual(['pending', 'completed', 'skipped', 'pending'])
  })

  it('returns nothing rather than throwing on a malformed rule', () => {
    const t = task({ recurrence: 'FREQ=NOPE' })
    expect(occurrencesBetween(t, day('2026-09-01'), day('2026-09-30'))).toEqual([])
  })

  it('honours COUNT and UNTIL', () => {
    const counted = task({ recurrence: 'DTSTART:20260901;FREQ=DAILY;COUNT=3' })
    expect(occurrencesBetween(counted, day('2026-09-01'), day('2026-09-30'))).toHaveLength(3)

    const until = task({ recurrence: 'DTSTART:20260901;FREQ=DAILY;UNTIL=20260903T000000Z' })
    expect(occurrencesBetween(until, day('2026-09-01'), day('2026-09-30'))).toHaveLength(3)
  })
})

describe('nextOccurrence', () => {
  it('finds the next date strictly after the given day', () => {
    const t = task({ recurrence: 'DTSTART:20260907;FREQ=WEEKLY;BYDAY=MO' })
    expect(nextOccurrence(t, day('2026-09-07'))?.date).toBe('2026-09-14')
  })

  it('returns null when the rule is exhausted', () => {
    const t = task({ recurrence: 'DTSTART:20260901;FREQ=DAILY;COUNT=2' })
    expect(nextOccurrence(t, day('2026-09-05'))).toBeNull()
  })
})

describe('instance operations', () => {
  it('completing an instance never touches the base status', () => {
    const t = task({ recurrence: 'FREQ=WEEKLY', status: 'in-progress' })
    const patch = completeInstance(t, '2026-09-07')
    expect(patch.status).toBeUndefined()
    expect(patch.completeInstances).toEqual(['2026-09-07'])
  })

  it('is idempotent', () => {
    const t = task({ recurrence: 'FREQ=WEEKLY', completeInstances: ['2026-09-07'] })
    expect(completeInstance(t, '2026-09-07').completeInstances).toEqual(['2026-09-07'])
  })

  it('moves an instance out of the skipped list when completed', () => {
    const t = task({ recurrence: 'FREQ=WEEKLY', skippedInstances: ['2026-09-07'] })
    const patch = completeInstance(t, '2026-09-07')
    expect(patch.completeInstances).toEqual(['2026-09-07'])
    expect(patch.skippedInstances).toEqual([])
  })

  it('never leaves a date in both lists', () => {
    const t = task({ recurrence: 'FREQ=WEEKLY', completeInstances: ['2026-09-07'] })
    const patch = skipInstance(t, '2026-09-07')
    expect(patch.completeInstances).toEqual([])
    expect(patch.skippedInstances).toEqual(['2026-09-07'])
  })

  it('advances DTSTART only under completion anchoring', () => {
    const anchored = task({
      recurrence: 'DTSTART:20260901;FREQ=WEEKLY',
      recurrenceAnchor: 'completion'
    })
    expect(completeInstance(anchored, '2026-09-10').recurrence).toBe(
      'DTSTART:20260910;FREQ=WEEKLY'
    )

    const scheduled = task({
      recurrence: 'DTSTART:20260901;FREQ=WEEKLY',
      recurrenceAnchor: 'scheduled'
    })
    expect(completeInstance(scheduled, '2026-09-10').recurrence).toBeUndefined()
  })

  it('does not roll DTSTART back on uncomplete', () => {
    const t = task({
      recurrence: 'DTSTART:20260910;FREQ=WEEKLY',
      recurrenceAnchor: 'completion',
      completeInstances: ['2026-09-10']
    })
    const patch = uncompleteInstance(t, '2026-09-10')
    expect(patch.recurrence).toBeUndefined()
    expect(patch.completeInstances).toEqual([])
  })

  it('reads back the state it just wrote', () => {
    const t = task({ recurrence: 'FREQ=WEEKLY' })
    const after = { ...t, ...completeInstance(t, '2026-09-07') }
    expect(instanceState(after, '2026-09-07')).toBe('completed')
    expect(instanceState(after, '2026-09-14')).toBe('pending')
  })
})

describe('withDtstart', () => {
  it('replaces an existing DTSTART and keeps every other component', () => {
    expect(withDtstart('DTSTART:20260101;FREQ=WEEKLY;BYDAY=MO,FR', '2026-09-10')).toBe(
      'DTSTART:20260910;FREQ=WEEKLY;BYDAY=MO,FR'
    )
  })

  it('inserts one when absent', () => {
    expect(withDtstart('FREQ=DAILY', '2026-09-10')).toBe('DTSTART:20260910;FREQ=DAILY')
  })

  it('produces a string that parses back to the same schedule', () => {
    const rule = withDtstart('FREQ=WEEKLY;BYDAY=TH', '2026-09-10')
    const dates = parseRecurrence(rule)
      .rule.all((_, i) => i < 2)
      .map((d) => d.toISOString().slice(0, 10))
    expect(dates).toEqual(['2026-09-10', '2026-09-17'])
  })
})

describe('ensureDtstart', () => {
  it('seeds a rule that has none', () => {
    expect(ensureDtstart(task({ recurrence: 'FREQ=DAILY', scheduled: '2026-05-04' }))).toBe(
      'DTSTART:20260504;FREQ=DAILY'
    )
  })

  it('leaves an anchored rule untouched', () => {
    const value = 'DTSTART:20260101;FREQ=DAILY'
    expect(ensureDtstart(task({ recurrence: value, scheduled: '2026-05-04' }))).toBe(value)
  })
})

describe('describeRecurrence', () => {
  it('summarises common rules in Spanish', () => {
    expect(describeRecurrence('FREQ=DAILY')).toBe('Cada día')
    expect(describeRecurrence('FREQ=WEEKLY;INTERVAL=2')).toBe('Cada 2 semanas')
    expect(describeRecurrence('FREQ=WEEKLY;BYDAY=MO,FR')).toContain('lun')
    expect(describeRecurrence('FREQ=DAILY;COUNT=5')).toContain('5 veces')
  })

  it('says so instead of throwing on nonsense', () => {
    expect(describeRecurrence('nonsense')).toBe('Regla inválida')
  })
})
