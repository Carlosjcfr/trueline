/**
 * Recurrence editor.
 *
 * Builds an RRULE from a handful of controls rather than asking anyone to type
 * `FREQ=WEEKLY;BYDAY=MO,FR;INTERVAL=2`. It covers the rules people actually set; a rule
 * the editor cannot express is shown as read-only text with its own summary instead of
 * being silently rewritten into something simpler. Downgrading a rule you did not
 * understand is how a plugin loses someone's schedule.
 *
 * The preview is the point of the whole panel: seeing the next four dates is the only
 * way to catch "every second Tuesday" when you meant "every other Tuesday".
 */

import { RRule } from 'rrule'
import type { Task } from '../types'
import {
  describeRecurrence,
  nextOccurrence,
  occurrencesBetween,
  parseRecurrence,
  withDtstart
} from '../recurrence'
import { fromDay, todayDay, toDay } from '../dates'

type Frequency = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly'

const WEEKDAYS = [
  { id: RRule.MO.weekday, code: 'MO', label: 'L' },
  { id: RRule.TU.weekday, code: 'TU', label: 'M' },
  { id: RRule.WE.weekday, code: 'WE', label: 'X' },
  { id: RRule.TH.weekday, code: 'TH', label: 'J' },
  { id: RRule.FR.weekday, code: 'FR', label: 'V' },
  { id: RRule.SA.weekday, code: 'SA', label: 'S' },
  { id: RRule.SU.weekday, code: 'SU', label: 'D' }
]

interface EditorState {
  frequency: Frequency
  interval: number
  weekdays: string[]
  endMode: 'never' | 'until' | 'count'
  until: string
  count: number
}

export interface RecurrenceEditorOptions {
  task: Task
  /** Receives the new rule string, or undefined when recurrence is switched off. */
  onChange: (recurrence: string | undefined, anchor: 'scheduled' | 'completion') => void
  anchor: 'scheduled' | 'completion'
}

export function renderRecurrenceEditor(
  container: HTMLElement,
  options: RecurrenceEditorOptions
): void {
  const { task } = options
  const panel = container.createDiv('tl-recur-panel')

  const state = readState(task.recurrence)
  const expressible = state !== null

  if (!expressible) {
    // Unrecognised but valid: show it, summarise it, and leave it alone.
    const custom = panel.createDiv('tl-recur-custom')
    custom.createSpan({ cls: 'tl-recur-summary', text: describeRecurrence(task.recurrence ?? '') })
    const raw = custom.createEl('input', { attr: { type: 'text' } })
    raw.value = task.recurrence ?? ''
    raw.addEventListener('change', () => {
      options.onChange(raw.value.trim() || undefined, options.anchor)
    })
    return
  }

  const current: EditorState = state

  const emit = (): void => {
    options.onChange(buildRule(current, task), options.anchor)
    render()
  }

  const body = panel.createDiv('tl-recur-body')

  const render = (): void => {
    body.empty()

    const row = body.createDiv('tl-recur-row')
    const freq = row.createEl('select', { cls: 'dropdown' })
    for (const [id, label] of [
      ['none', 'No se repite'],
      ['daily', 'Cada día'],
      ['weekly', 'Cada semana'],
      ['monthly', 'Cada mes'],
      ['yearly', 'Cada año']
    ] as const) {
      freq.createEl('option', { value: id, text: label })
    }
    freq.value = current.frequency
    freq.addEventListener('change', () => {
      current.frequency = freq.value as Frequency
      emit()
    })

    if (current.frequency === 'none') return

    const every = row.createEl('input', {
      cls: 'tl-recur-interval',
      attr: { type: 'number', min: '1', max: '99' }
    })
    every.value = String(current.interval)
    every.addEventListener('change', () => {
      const value = Number(every.value)
      current.interval = Number.isFinite(value) && value > 0 ? Math.floor(value) : 1
      emit()
    })
    row.createSpan({ cls: 'tl-recur-unit', text: unitLabel(current.frequency) })

    if (current.frequency === 'weekly') {
      const days = body.createDiv('tl-recur-days')
      for (const day of WEEKDAYS) {
        const active = current.weekdays.includes(day.code)
        const chip = days.createEl('button', {
          cls: `tl-recur-day${active ? ' tl-recur-day--on' : ''}`,
          text: day.label
        })
        chip.addEventListener('click', () => {
          current.weekdays = active
            ? current.weekdays.filter((code) => code !== day.code)
            : [...current.weekdays, day.code]
          emit()
        })
      }
    }

    const endRow = body.createDiv('tl-recur-row')
    const end = endRow.createEl('select', { cls: 'dropdown' })
    for (const [id, label] of [
      ['never', 'Sin fin'],
      ['until', 'Hasta el'],
      ['count', 'Número de veces']
    ] as const) {
      end.createEl('option', { value: id, text: label })
    }
    end.value = current.endMode
    end.addEventListener('change', () => {
      current.endMode = end.value as EditorState['endMode']
      emit()
    })

    if (current.endMode === 'until') {
      const until = endRow.createEl('input', { attr: { type: 'date' } })
      until.value = current.until
      until.addEventListener('change', () => {
        current.until = until.value
        emit()
      })
    }
    if (current.endMode === 'count') {
      const count = endRow.createEl('input', {
        attr: { type: 'number', min: '1', max: '999' }
      })
      count.value = String(current.count)
      count.addEventListener('change', () => {
        const value = Number(count.value)
        current.count = Number.isFinite(value) && value > 0 ? Math.floor(value) : 1
        emit()
      })
    }

    // -- anchor -------------------------------------------------------------
    const anchorRow = body.createDiv('tl-recur-row')
    anchorRow.createSpan({ cls: 'tl-recur-label', text: 'Contar desde' })
    const anchor = anchorRow.createEl('select', { cls: 'dropdown' })
    anchor.createEl('option', { value: 'scheduled', text: 'La fecha prevista' })
    anchor.createEl('option', { value: 'completion', text: 'Cuando la completo' })
    anchor.value = options.anchor
    anchor.addEventListener('change', () => {
      options.anchor = anchor.value as 'scheduled' | 'completion'
      options.onChange(buildRule(current, task), options.anchor)
    })

    renderPreview(body, current, task)
  }

  render()
}

function renderPreview(container: HTMLElement, state: EditorState, task: Task): void {
  const rule = buildRule(state, task)
  if (!rule) return

  const preview = container.createDiv('tl-recur-preview')
  try {
    parseRecurrence(rule, task)
  } catch (error) {
    preview.addClass('tl-recur-preview--error')
    preview.setText(error instanceof Error ? error.message : 'Regla inválida')
    return
  }

  const probe: Task = { ...task, recurrence: rule }
  const today = todayDay()
  const dates = occurrencesBetween(probe, today, today + 400)
    .slice(0, 4)
    .map((occurrence) => occurrence.date)

  if (dates.length === 0) {
    const next = nextOccurrence(probe, today)
    preview.setText(next ? `Próxima: ${next.date}` : 'No quedan ocurrencias futuras.')
    return
  }

  preview.createSpan({ cls: 'tl-recur-preview-label', text: 'Próximas:' })
  for (const date of dates) {
    preview.createSpan({ cls: 'tl-recur-preview-date', text: date })
  }
}

function unitLabel(frequency: Frequency): string {
  switch (frequency) {
    case 'daily':
      return 'día(s)'
    case 'weekly':
      return 'semana(s)'
    case 'monthly':
      return 'mes(es)'
    default:
      return 'año(s)'
  }
}

/**
 * Reads the stored rule back into editor state, or returns null when the rule uses
 * anything the editor cannot round-trip faithfully.
 */
function readState(recurrence: string | undefined): EditorState | null {
  const empty: EditorState = {
    frequency: 'none',
    interval: 1,
    weekdays: [],
    endMode: 'never',
    until: fromDay(todayDay() + 30),
    count: 10
  }
  if (!recurrence) return empty

  let options
  try {
    options = parseRecurrence(recurrence).rule.origOptions
  } catch {
    return null
  }

  const frequency =
    options.freq === RRule.DAILY
      ? 'daily'
      : options.freq === RRule.WEEKLY
        ? 'weekly'
        : options.freq === RRule.MONTHLY
          ? 'monthly'
          : options.freq === RRule.YEARLY
            ? 'yearly'
            : null

  if (!frequency) return null

  // Anything beyond frequency, interval, weekday set and an end condition is out of
  // the editor's vocabulary.
  const unsupported = ['bymonthday', 'bymonth', 'bysetpos', 'byhour', 'byminute'] as const
  for (const key of unsupported) {
    const value = (options as Record<string, unknown>)[key]
    if (value !== undefined && value !== null) return null
  }

  const weekdays = toWeekdayCodes(options.byweekday)
  if (frequency !== 'weekly' && weekdays.length) return null

  return {
    frequency,
    interval: options.interval ?? 1,
    weekdays,
    endMode: options.until ? 'until' : options.count ? 'count' : 'never',
    until: options.until ? options.until.toISOString().slice(0, 10) : empty.until,
    count: options.count ?? 10
  }
}

function toWeekdayCodes(byweekday: unknown): string[] {
  if (byweekday === undefined || byweekday === null) return []
  const list = Array.isArray(byweekday) ? byweekday : [byweekday]
  const codes: string[] = []
  for (const item of list) {
    const index =
      typeof item === 'number'
        ? item
        : typeof item === 'object' && item !== null && 'weekday' in item
          ? (item as { weekday: number }).weekday
          : -1
    const match = WEEKDAYS.find((day) => day.id === index)
    if (match) codes.push(match.code)
  }
  return codes
}

function buildRule(state: EditorState, task: Task): string | undefined {
  if (state.frequency === 'none') return undefined

  const parts = [`FREQ=${state.frequency.toUpperCase()}`]
  if (state.interval > 1) parts.push(`INTERVAL=${state.interval}`)
  if (state.frequency === 'weekly' && state.weekdays.length) {
    // Keep calendar order, not click order, so the stored rule is stable.
    const ordered = WEEKDAYS.filter((day) => state.weekdays.includes(day.code)).map(
      (day) => day.code
    )
    parts.push(`BYDAY=${ordered.join(',')}`)
  }
  if (state.endMode === 'until' && state.until) {
    parts.push(`UNTIL=${state.until.replace(/-/g, '')}T000000Z`)
  }
  if (state.endMode === 'count') {
    parts.push(`COUNT=${state.count}`)
  }

  // §4.5: a persisted rule carries its seed, so the schedule cannot drift with the
  // day it happens to be read on.
  const seed = toDay(task.scheduled) ?? toDay(task.dateCreated) ?? todayDay()
  return withDtstart(parts.join(';'), fromDay(seed))
}
