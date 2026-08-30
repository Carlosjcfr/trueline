/**
 * Recurrence, per spec §4.
 *
 * The stored value is a "tasknotes recurrence string": an optional inline `DTSTART`
 * segment followed by RRULE parameters, all on one line -
 * `DTSTART:20260220;FREQ=WEEKLY;BYDAY=FR`.
 *
 * That single-line form has to be split by hand before handing it to `rrule`.
 * `rrulestr` expects DTSTART on its own line, and given the combined form it silently
 * mis-parses: `DTSTART:20260220;FREQ=WEEKLY;BYDAY=FR` comes back yielding one date per
 * *year*. It does not throw, it just returns the wrong schedule - which is the worst
 * kind of bug for a calendar. So we parse the DTSTART segment ourselves and pass the
 * remainder to `RRule.parseString`.
 *
 * Instance state (§4.11) resolves in a fixed order: completed, then skipped, then
 * pending. Overlap between the two lists is invalid, so the order is deterministic.
 */

import { RRule, type Options } from 'rrule'
import type { Task } from './types'
import { fromDay, toDay, type DayNumber } from './dates'

export type InstanceState = 'completed' | 'skipped' | 'pending'

export interface Occurrence {
  day: DayNumber
  date: string
  state: InstanceState
}

export interface ParsedRecurrence {
  rule: RRule
  /** True when the stored string carried its own DTSTART. */
  hadDtstart: boolean
}

export class RecurrenceError extends Error {}

const DTSTART = /^DTSTART:(\d{8})(?:T(\d{6})Z)?;?/

/**
 * Resolves the seed date, in the precedence §4.4.1 requires: inline DTSTART, then
 * `scheduled`, then `date_created`. A rule with no resolvable seed is an error rather
 * than a guess - "today" would make the schedule depend on when you opened the vault.
 */
export function parseRecurrence(recurrence: string, task?: Task): ParsedRecurrence {
  const raw = recurrence.trim().replace(/^RRULE:/i, '')
  if (!raw) throw new RecurrenceError('Regla de recurrencia vacía')

  const match = DTSTART.exec(raw)
  let dtstart: Date | null = null
  let rest = raw

  if (match) {
    dtstart = parseStamp(match[1] as string, match[2])
    rest = raw.slice(match[0].length)
  } else if (task) {
    const seedDay = toDay(task.scheduled) ?? toDay(task.dateCreated)
    if (seedDay === null) {
      throw new RecurrenceError('missing_recurrence_seed')
    }
    dtstart = new Date(seedDay * 86_400_000)
  }

  if (!rest) throw new RecurrenceError('La regla no contiene parámetros RRULE')

  let options: Partial<Options>
  try {
    options = RRule.parseString(rest)
  } catch (error) {
    throw new RecurrenceError(
      `Regla inválida: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  if (dtstart) options.dtstart = dtstart

  return { rule: new RRule(options), hadDtstart: Boolean(match) }
}

/** Occurrences in `[from, to]`, each carrying its resolved instance state. */
export function occurrencesBetween(
  task: Task,
  from: DayNumber,
  to: DayNumber
): Occurrence[] {
  if (!task.recurrence) return []

  let parsed: ParsedRecurrence
  try {
    parsed = parseRecurrence(task.recurrence, task)
  } catch {
    // A malformed rule must not take the calendar down with it. Validation surfaces
    // the problem elsewhere; here the task simply contributes no occurrences.
    return []
  }

  const completed = new Set(task.completeInstances)
  const skipped = new Set(task.skippedInstances)

  return parsed.rule
    .between(new Date(from * 86_400_000), new Date(to * 86_400_000), true)
    .map((date) => {
      const day = Math.floor(date.getTime() / 86_400_000)
      const iso = fromDay(day)
      return {
        day,
        date: iso,
        state: completed.has(iso) ? 'completed' : skipped.has(iso) ? 'skipped' : 'pending'
      } satisfies Occurrence
    })
}

/** The next occurrence strictly after `after`, or null when the rule is exhausted. */
export function nextOccurrence(task: Task, after: DayNumber): Occurrence | null {
  if (!task.recurrence) return null
  let parsed: ParsedRecurrence
  try {
    parsed = parseRecurrence(task.recurrence, task)
  } catch {
    return null
  }

  const date = parsed.rule.after(new Date(after * 86_400_000), false)
  if (!date) return null

  const day = Math.floor(date.getTime() / 86_400_000)
  const iso = fromDay(day)
  return {
    day,
    date: iso,
    state: task.completeInstances.includes(iso)
      ? 'completed'
      : task.skippedInstances.includes(iso)
        ? 'skipped'
        : 'pending'
  }
}

/** §4.11. */
export function instanceState(task: Task, date: string): InstanceState {
  if (task.completeInstances.includes(date)) return 'completed'
  if (task.skippedInstances.includes(date)) return 'skipped'
  return 'pending'
}

/**
 * Completing one instance.
 *
 * Idempotent, and it never touches the base `status`: §4.12 is explicit that instance
 * completion does not mark the recurring task itself done. Marking it done is what
 * makes a weekly review disappear from every future week.
 *
 * Under `completion` anchoring the progression baseline moves, so DTSTART is rewritten
 * to the completed day (§4.4.3).
 */
export function completeInstance(task: Task, date: string): Partial<Task> {
  const complete = unique([...task.completeInstances, date])
  const skipped = task.skippedInstances.filter((item) => item !== date)

  const patch: Partial<Task> = {
    completeInstances: complete,
    skippedInstances: skipped
  }

  if (task.recurrenceAnchor === 'completion' && task.recurrence) {
    patch.recurrence = withDtstart(task.recurrence, date)
  }

  return patch
}

/** Idempotent inverse. Under `completion` anchoring DTSTART is deliberately left
 *  alone: §4.7 says rolling progression back needs an explicit rewind, not a toggle. */
export function uncompleteInstance(task: Task, date: string): Partial<Task> {
  return {
    completeInstances: task.completeInstances.filter((item) => item !== date)
  }
}

export function skipInstance(task: Task, date: string): Partial<Task> {
  return {
    skippedInstances: unique([...task.skippedInstances, date]),
    completeInstances: task.completeInstances.filter((item) => item !== date)
  }
}

export function unskipInstance(task: Task, date: string): Partial<Task> {
  return {
    skippedInstances: task.skippedInstances.filter((item) => item !== date)
  }
}

/**
 * Replaces or inserts the DTSTART segment, preserving every other RRULE component
 * (§4.4.3 rule 4). Date-only form, because instance state is always keyed by day.
 */
export function withDtstart(recurrence: string, date: string): string {
  const stamp = date.slice(0, 10).replace(/-/g, '')
  const raw = recurrence.trim().replace(/^RRULE:/i, '')
  const match = DTSTART.exec(raw)
  const rest = match ? raw.slice(match[0].length) : raw
  return `DTSTART:${stamp};${rest}`
}

/** Ensures a persisted rule carries a DTSTART (§4.5), seeding it if needed. */
export function ensureDtstart(task: Task): string | undefined {
  if (!task.recurrence) return undefined
  if (DTSTART.test(task.recurrence.trim().replace(/^RRULE:/i, ''))) return task.recurrence

  const seed = toDay(task.scheduled) ?? toDay(task.dateCreated)
  if (seed === null) return task.recurrence
  return withDtstart(task.recurrence, fromDay(seed))
}

/** A human summary for the modal, without dragging in rrule's own i18n. */
export function describeRecurrence(recurrence: string): string {
  let parsed: ParsedRecurrence
  try {
    parsed = parseRecurrence(recurrence)
  } catch {
    return 'Regla inválida'
  }

  const options = parsed.rule.origOptions
  const interval = options.interval ?? 1
  const freq = options.freq

  const unit =
    freq === RRule.DAILY
      ? interval === 1 ? 'Cada día' : `Cada ${interval} días`
      : freq === RRule.WEEKLY
        ? interval === 1 ? 'Cada semana' : `Cada ${interval} semanas`
        : freq === RRule.MONTHLY
          ? interval === 1 ? 'Cada mes' : `Cada ${interval} meses`
          : freq === RRule.YEARLY
            ? interval === 1 ? 'Cada año' : `Cada ${interval} años`
            : 'Personalizada'

  const days = toWeekdayLabels(options.byweekday)
  const parts = [unit]
  if (days.length) parts.push(`(${days.join(', ')})`)
  if (options.count) parts.push(`· ${options.count} veces`)
  if (options.until) parts.push(`· hasta ${options.until.toISOString().slice(0, 10)}`)
  return parts.join(' ')
}

const WEEKDAY_LABELS = ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom']

function toWeekdayLabels(byweekday: Options['byweekday'] | undefined): string[] {
  if (byweekday === undefined || byweekday === null) return []
  const list = Array.isArray(byweekday) ? byweekday : [byweekday]
  return list
    .map((item) => {
      const index =
        typeof item === 'number'
          ? item
          : typeof item === 'object' && item !== null && 'weekday' in item
            ? (item as { weekday: number }).weekday
            : -1
      return WEEKDAY_LABELS[index] ?? null
    })
    .filter((label): label is string => label !== null)
}

function parseStamp(date: string, time: string | undefined): Date {
  const year = Number(date.slice(0, 4))
  const month = Number(date.slice(4, 6)) - 1
  const day = Number(date.slice(6, 8))
  if (!time) return new Date(Date.UTC(year, month, day))
  return new Date(
    Date.UTC(
      year,
      month,
      day,
      Number(time.slice(0, 2)),
      Number(time.slice(2, 4)),
      Number(time.slice(4, 6))
    )
  )
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort()
}
