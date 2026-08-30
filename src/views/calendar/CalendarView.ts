/**
 * Calendar view.
 *
 * Two kinds of entry share the grid:
 *
 *  - **Real tasks**, placed on `due` (or `scheduled` when there is no due date).
 *  - **Virtual occurrences** of recurring tasks, expanded per window. These have no
 *    note of their own - the recurring task is one file - so completing one writes to
 *    `complete_instances` rather than to a status. That is the whole point of §4.12:
 *    a weekly review that gets marked "done" would vanish from every future week.
 *
 * Dragging moves a real task's date. Virtual occurrences are not draggable: moving one
 * would mean editing the rule for every future instance, which is never what dragging
 * a single day means.
 */

import { setIcon, setTooltip } from 'obsidian'
import type ProjectNotesPlugin from '../../main'
import type { Task } from '../../types'
import { openTaskModal } from '../../modals/TaskModal'
import { completeInstance, occurrencesBetween, uncompleteInstance } from '../../recurrence'
import {
  dayOfWeek,
  fromDay,
  monthLabel,
  toDay,
  todayDay,
  weekNumber,
  type DayNumber
} from '../../dates'

export type CalendarScope = 'month' | 'week'

interface Entry {
  task: Task
  /** Set for a recurring occurrence; absent for a plain dated task. */
  occurrence?: string
  state: 'completed' | 'skipped' | 'pending'
}

const WEEKDAY_HEADERS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom']

export function renderCalendar(
  container: HTMLElement,
  plugin: ProjectNotesPlugin,
  tasks: Task[],
  projectPath: string | undefined,
  scope: CalendarScope,
  anchor: DayNumber,
  onNavigate: (scope: CalendarScope, anchor: DayNumber) => void
): void {
  const config = plugin.projects.resolve(projectPath)
  const { start, end } = windowFor(scope, anchor)

  // -- header ---------------------------------------------------------------
  const header = container.createDiv('pn-cal-header')

  const prev = header.createEl('button', { cls: 'clickable-icon' })
  setIcon(prev, 'chevron-left')
  prev.addEventListener('click', () => onNavigate(scope, shift(scope, anchor, -1)))

  const next = header.createEl('button', { cls: 'clickable-icon' })
  setIcon(next, 'chevron-right')
  next.addEventListener('click', () => onNavigate(scope, shift(scope, anchor, 1)))

  header.createEl('button', { text: 'Hoy' }).addEventListener('click', () => {
    onNavigate(scope, todayDay())
  })

  header.createSpan({
    cls: 'pn-cal-title',
    text: scope === 'month' ? monthLabel(anchor) : `Semana ${weekNumber(anchor)} · ${monthLabel(anchor)}`
  })

  const switcher = header.createDiv('pn-view-switcher')
  for (const [id, label] of [
    ['month', 'Mes'],
    ['week', 'Semana']
  ] as const) {
    const button = switcher.createEl('button', {
      cls: `pn-view-btn${scope === id ? ' pn-view-btn--active' : ''}`,
      text: label
    })
    button.addEventListener('click', () => onNavigate(id, anchor))
  }

  // -- index ----------------------------------------------------------------
  const byDay = new Map<string, Entry[]>()
  const push = (date: string, entry: Entry): void => {
    const list = byDay.get(date)
    if (list) list.push(entry)
    else byDay.set(date, [entry])
  }

  for (const task of tasks) {
    if (task.recurrence) {
      for (const occurrence of occurrencesBetween(task, start, end)) {
        push(occurrence.date, { task, occurrence: occurrence.date, state: occurrence.state })
      }
      continue
    }
    const day = toDay(task.due) ?? toDay(task.scheduled)
    if (day === null || day < start || day > end) continue
    push(fromDay(day), {
      task,
      state: config.statuses.find((s) => s.id === task.status)?.complete ? 'completed' : 'pending'
    })
  }

  // -- grid -----------------------------------------------------------------
  const grid = container.createDiv(`pn-cal-grid pn-cal-grid--${scope}`)
  for (const label of WEEKDAY_HEADERS) {
    grid.createDiv({ cls: 'pn-cal-weekday', text: label })
  }

  const today = todayDay()
  for (let day = start; day <= end; day++) {
    const date = fromDay(day)
    const cell = grid.createDiv('pn-cal-cell')
    if (day === today) cell.addClass('pn-cal-cell--today')
    if (scope === 'month' && !inSameMonth(day, anchor)) cell.addClass('pn-cal-cell--outside')

    const number = cell.createDiv('pn-cal-daynum')
    number.setText(String(new Date(day * 86_400_000).getUTCDate()))

    // Clicking empty space in a day creates a task scheduled there. It is the fastest
    // path from "I should do this on Thursday" to a note that says so.
    cell.addEventListener('dblclick', async (event) => {
      if (event.target !== cell && event.target !== number) return
      const { createTask } = await import('../../store/create')
      await createTask(plugin.app, plugin.settings, { scheduled: date, due: date })
    })

    cell.addEventListener('dragover', (event) => {
      event.preventDefault()
      cell.addClass('pn-cal-cell--drop')
    })
    cell.addEventListener('dragleave', () => cell.removeClass('pn-cal-cell--drop'))
    cell.addEventListener('drop', (event) => {
      event.preventDefault()
      cell.removeClass('pn-cal-cell--drop')
      const path = event.dataTransfer?.getData('text/plain')
      if (!path) return
      const dragged = plugin.tasks.get(path)
      if (!dragged) return
      // Keep the duration: dragging a bar in a calendar moves it, it does not resize it.
      const oldStart = toDay(dragged.scheduled)
      const oldDue = toDay(dragged.due)
      const length = oldStart !== null && oldDue !== null ? oldDue - oldStart : 0
      void plugin.tasks.update(path, {
        ...(oldStart !== null ? { scheduled: date } : {}),
        due: fromDay(day + (oldStart !== null ? length : 0))
      })
    })

    for (const entry of byDay.get(date) ?? []) {
      renderEntry(cell, plugin, entry, config)
    }
  }
}

function renderEntry(
  cell: HTMLElement,
  plugin: ProjectNotesPlugin,
  entry: Entry,
  config: { statuses: { id: string; color: string; complete: boolean }[] }
): void {
  const { task, occurrence, state } = entry
  const pill = cell.createDiv(`pn-cal-entry pn-cal-entry--${state}`)

  const status = config.statuses.find((s) => s.id === task.status)
  pill.style.borderLeftColor = status?.color ?? 'var(--text-faint)'

  if (occurrence) {
    const icon = pill.createSpan({ cls: 'pn-cal-entry-icon' })
    setIcon(icon, 'repeat')
    setTooltip(icon, 'Ocurrencia recurrente')

    // One click toggles just this instance. The rule and the base status stay put.
    icon.addEventListener('click', async (event) => {
      event.stopPropagation()
      const fresh = plugin.tasks.get(task.path) ?? task
      await plugin.tasks.update(
        task.path,
        state === 'completed'
          ? uncompleteInstance(fresh, occurrence)
          : completeInstance(fresh, occurrence)
      )
    })
  } else {
    pill.draggable = true
    pill.addEventListener('dragstart', (event) => {
      event.dataTransfer?.setData('text/plain', task.path)
    })
  }

  if (task.milestone) setIcon(pill.createSpan({ cls: 'pn-cal-entry-icon' }), 'diamond')

  pill.createSpan({ cls: 'pn-cal-entry-title', text: task.title })
  pill.addEventListener('click', () => openTaskModal(plugin, task))
}

/** Whole weeks, Monday-first, so the grid is always a clean set of rows. */
function windowFor(scope: CalendarScope, anchor: DayNumber): { start: DayNumber; end: DayNumber } {
  if (scope === 'week') {
    const start = anchor - (dayOfWeek(anchor) - 1)
    return { start, end: start + 6 }
  }
  const date = new Date(anchor * 86_400_000)
  const first = Math.floor(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / 86_400_000
  )
  const last = Math.floor(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0) / 86_400_000
  )
  return { start: first - (dayOfWeek(first) - 1), end: last + (7 - dayOfWeek(last)) }
}

function shift(scope: CalendarScope, anchor: DayNumber, direction: number): DayNumber {
  if (scope === 'week') return anchor + 7 * direction
  const date = new Date(anchor * 86_400_000)
  return Math.floor(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + direction, 1) / 86_400_000
  )
}

function inSameMonth(day: DayNumber, anchor: DayNumber): boolean {
  const a = new Date(day * 86_400_000)
  const b = new Date(anchor * 86_400_000)
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth()
}
