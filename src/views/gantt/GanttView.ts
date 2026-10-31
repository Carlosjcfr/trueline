/**
 * Gantt chart.
 *
 * Structure ported from Project Manager (Copyright (c) 2026 Stepan Kropachev, MIT —
 * see licenses/obsidian-pm.LICENSE): a fixed label column beside a scrolling SVG, with
 * a sticky header SVG carrying the date scale so it survives vertical scrolling.
 *
 * Rewritten to read the spec's roles: `scheduled`/`due` for the bar, `blockedBy` with
 * its `reltype` and `gap` for the arrows, `milestone` for the diamonds.
 *
 * Dragging commits on pointer-up, not on every move — a Gantt drag crosses dozens of
 * day columns and writing the note at each one would produce dozens of vault writes and
 * a scrolling wall of undo steps.
 */

import { Notice, setIcon } from 'obsidian'
import type TruelinePlugin from '../../main'
import type { Task } from '../../types'
import { fromDay, toDay, todayDay, monthLabel, quarterLabel, weekNumber } from '../../dates'
import { openTaskModal } from '../../modals/TaskModal'
import { reschedule } from '../../store/scheduler'
import {
  BAR_PADDING,
  DAY_WIDTH,
  HEADER_HEIGHT,
  LABEL_WIDTH,
  ROW_HEIGHT,
  buildTimeline,
  dateToX,
  dayGranularityLabel,
  isQuarterStart,
  isWeekend,
  snapPoints,
  snapX,
  svgEl,
  xToDate,
  type Granularity,
  type Timeline
} from './timeline'
import { dayOfMonth, dayOfWeek, monthOf, yearOf } from '../../dates'

const GRANULARITIES: { id: Granularity; label: string }[] = [
  { id: 'day', label: 'Día' },
  { id: 'week', label: 'Semana' },
  { id: 'month', label: 'Mes' },
  { id: 'quarter', label: 'Trimestre' },
  { id: 'year', label: 'Año' }
]

type DragMode = 'move' | 'resize-start' | 'resize-end'

interface DragState {
  task: Task
  mode: DragMode
  originX: number
  startDay: number
  endDay: number
  rect: SVGRectElement
}

export function renderGantt(
  container: HTMLElement,
  plugin: TruelinePlugin,
  tasks: Task[],
  projectPath: string | undefined,
  granularity: Granularity,
  onGranularityChange: (next: Granularity) => void
): () => void {
  const config = plugin.projects.resolve(projectPath)
  const cleanups: (() => void)[] = []

  // Only tasks with at least one date can be placed. The rest are listed above the
  // chart rather than dropped, so an undated task is visible and fixable.
  const dated = tasks.filter((task) => task.scheduled || task.due)
  const undated = tasks.filter((task) => !task.scheduled && !task.due)

  const controls = container.createDiv('tl-gantt-controls')
  for (const level of GRANULARITIES) {
    const button = controls.createEl('button', {
      cls: `tl-view-btn${granularity === level.id ? ' tl-view-btn--active' : ''}`,
      text: level.label
    })
    button.addEventListener('click', () => onGranularityChange(level.id))
  }
  const todayButton = controls.createEl('button', { text: 'Hoy' })

  if (dated.length === 0) {
    container.createDiv('tl-empty-state').setText('Ninguna tarea tiene fechas todavía.')
    return () => {}
  }

  const timeline = buildTimeline(dated, granularity)
  const rows = dated.slice().sort(byStart)
  const height = HEADER_HEIGHT + rows.length * ROW_HEIGHT

  const chart = container.createDiv('tl-gantt')
  const labels = chart.createDiv('tl-gantt-labels')
  labels.style.width = `${LABEL_WIDTH}px`
  const right = chart.createDiv('tl-gantt-right')

  // -- labels --------------------------------------------------------------
  labels.createDiv('tl-gantt-label-header').style.height = `${HEADER_HEIGHT}px`
  for (const task of rows) {
    const row = labels.createDiv('tl-gantt-label-row')
    row.style.height = `${ROW_HEIGHT}px`
    const status = config.statuses.find((s) => s.id === task.status)
    const icon = row.createSpan({ cls: 'tl-gantt-label-icon' })
    setIcon(icon, task.milestone ? 'diamond' : (status?.icon ?? 'circle'))
    icon.style.color = status?.color ?? 'var(--text-muted)'
    const link = row.createSpan({ cls: 'tl-task-link', text: task.title })
    link.addEventListener('click', () => openTaskModal(plugin, task))
  }

  // -- header scale --------------------------------------------------------
  const headerSvg = svgEl('svg', {
    class: 'tl-gantt-header-svg',
    width: timeline.totalWidth,
    height: HEADER_HEIGHT
  })
  right.appendChild(headerSvg)
  renderScale(headerSvg, timeline)

  // -- chart body ----------------------------------------------------------
  const svg = svgEl('svg', {
    class: 'tl-gantt-svg',
    width: timeline.totalWidth,
    height: height - HEADER_HEIGHT
  })
  right.appendChild(svg)

  renderGrid(svg, timeline, rows.length)
  renderTodayLine(svg, timeline, height - HEADER_HEIGHT)
  renderArrows(svg, plugin, timeline, rows)

  const drag: { current: DragState | null } = { current: null }
  rows.forEach((task, index) => renderBar(svg, plugin, timeline, task, index, config, drag, cleanups))

  // -- drag wiring (one listener pair for the whole chart) ------------------
  const onMove = (event: PointerEvent): void => {
    const state = drag.current
    if (!state) return
    const delta = event.clientX - state.originX
    const points = snapPoints(timeline)
    const threshold = timeline.dayWidth / 2

    let startX = dateToX(timeline, state.startDay)
    let endX = dateToX(timeline, state.endDay + 1)

    if (state.mode === 'move') {
      const width = endX - startX
      startX = snapX(startX + delta, points, threshold)
      endX = startX + width
    } else if (state.mode === 'resize-start') {
      startX = Math.min(snapX(startX + delta, points, threshold), endX - timeline.dayWidth)
    } else {
      endX = Math.max(snapX(endX + delta, points, threshold), startX + timeline.dayWidth)
    }

    state.rect.setAttribute('x', String(startX))
    state.rect.setAttribute('width', String(Math.max(timeline.dayWidth, endX - startX)))
  }

  const onUp = (): void => {
    const state = drag.current
    if (!state) return
    drag.current = null
    document.body.removeClass('tl-dragging')

    const startX = Number(state.rect.getAttribute('x'))
    const width = Number(state.rect.getAttribute('width'))
    const newStart = xToDate(timeline, startX)
    const newEnd = xToDate(timeline, startX + width) - 1

    if (newStart === state.startDay && newEnd === state.endDay) return

    void commit(plugin, config.autoSchedule, state.task, newStart, newEnd)
  }

  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  cleanups.push(() => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
  })

  // -- undated tasks -------------------------------------------------------
  if (undated.length) {
    const box = container.createDiv('tl-gantt-undated')
    box.createSpan({ cls: 'tl-gantt-undated-label', text: 'Sin fechas:' })
    for (const task of undated) {
      const chip = box.createSpan({ cls: 'tl-chip tl-chip--outline', text: task.title })
      chip.addEventListener('click', () => openTaskModal(plugin, task))
    }
  }

  const scrollToToday = (): void => {
    right.scrollLeft = Math.max(0, dateToX(timeline, todayDay()) - right.clientWidth / 3)
  }
  todayButton.addEventListener('click', scrollToToday)
  scrollToToday()

  return () => {
    for (const cleanup of cleanups) cleanup()
  }
}

// ---------------------------------------------------------------------------

function byStart(a: Task, b: Task): number {
  const left = toDay(a.scheduled) ?? toDay(a.due) ?? 0
  const right = toDay(b.scheduled) ?? toDay(b.due) ?? 0
  return left - right
}

/** A task with only one date occupies exactly that day. */
function span(task: Task): { start: number; end: number } | null {
  const scheduled = toDay(task.scheduled)
  const due = toDay(task.due)
  if (scheduled === null && due === null) return null
  const start = scheduled ?? (due as number)
  const end = due ?? (scheduled as number)
  return { start, end: Math.max(start, end) }
}

function renderScale(svg: SVGSVGElement, timeline: Timeline): void {
  const group = svgEl('g')
  let cursor = 0

  while (cursor <= timeline.totalDays) {
    const day = timeline.start + cursor
    const x = cursor * timeline.dayWidth
    const major = majorTick(timeline, day)

    if (major) {
      group.appendChild(
        svgEl('line', { x1: x, y1: 0, x2: x, y2: HEADER_HEIGHT, class: 'tl-gantt-tick' })
      )
      const label = svgEl('text', { x: x + 4, y: 20, class: 'tl-gantt-scale-major' })
      label.textContent = major
      group.appendChild(label)
    }

    const minor = dayGranularityLabel(timeline, day)
    if (minor) {
      const label = svgEl('text', {
        x: x + timeline.dayWidth / 2,
        y: 40,
        class: 'tl-gantt-scale-minor',
        'text-anchor': 'middle'
      })
      label.textContent = minor
      group.appendChild(label)
    }
    cursor++
  }
  svg.appendChild(group)
}

function majorTick(timeline: Timeline, day: number): string | null {
  switch (timeline.granularity) {
    case 'day':
    case 'week':
      return dayOfMonth(day) === 1 ? monthLabel(day) : null
    case 'month':
      return dayOfMonth(day) === 1 ? monthLabel(day) : null
    case 'quarter':
      return isQuarterStart(day) ? quarterLabel(day) : null
    default:
      // At year zoom only January carries a label; anything denser overlaps.
      return dayOfMonth(day) === 1 && monthOf(day) === 1 ? String(yearOf(day)) : null
  }
}

function renderGrid(svg: SVGSVGElement, timeline: Timeline, rowCount: number): void {
  const group = svgEl('g', { class: 'tl-gantt-grid' })
  const height = rowCount * ROW_HEIGHT

  for (let i = 0; i < timeline.totalDays; i++) {
    const day = timeline.start + i
    const x = i * timeline.dayWidth

    if (timeline.granularity === 'day' && isWeekend(day)) {
      group.appendChild(
        svgEl('rect', {
          x,
          y: 0,
          width: timeline.dayWidth,
          height,
          class: 'tl-gantt-weekend'
        })
      )
    }

    const drawLine =
      (timeline.granularity === 'day' && dayOfWeek(day) === 1) ||
      (timeline.granularity === 'week' && dayOfWeek(day) === 1) ||
      (timeline.granularity === 'month' && dayOfMonth(day) === 1) ||
      ((timeline.granularity === 'quarter' || timeline.granularity === 'year') &&
        isQuarterStart(day))

    if (drawLine) {
      group.appendChild(
        svgEl('line', { x1: x, y1: 0, x2: x, y2: height, class: 'tl-gantt-gridline-v' })
      )
    }
  }

  for (let row = 0; row <= rowCount; row++) {
    const y = row * ROW_HEIGHT
    group.appendChild(
      svgEl('line', {
        x1: 0,
        y1: y,
        x2: timeline.totalWidth,
        y2: y,
        class: 'tl-gantt-gridline-h'
      })
    )
  }
  svg.appendChild(group)
}

function renderTodayLine(svg: SVGSVGElement, timeline: Timeline, height: number): void {
  const x = dateToX(timeline, todayDay())
  if (x < 0 || x > timeline.totalWidth) return
  svg.appendChild(
    svgEl('line', { x1: x, y1: 0, x2: x, y2: height, class: 'tl-gantt-today-line' })
  )
}

function renderBar(
  svg: SVGSVGElement,
  plugin: TruelinePlugin,
  timeline: Timeline,
  task: Task,
  index: number,
  config: { statuses: { id: string; color: string; complete: boolean }[] },
  drag: { current: DragState | null },
  cleanups: (() => void)[]
): void {
  const bounds = span(task)
  if (!bounds) return

  const y = index * ROW_HEIGHT + BAR_PADDING
  const barHeight = ROW_HEIGHT - BAR_PADDING * 2
  const x = dateToX(timeline, bounds.start)
  const width = Math.max(timeline.dayWidth, dateToX(timeline, bounds.end + 1) - x)
  const color = config.statuses.find((s) => s.id === task.status)?.color ?? '#3b82f6'

  const group = svgEl('g', { class: 'tl-gantt-bar-group' })

  if (task.milestone) {
    const cx = x + timeline.dayWidth / 2
    const cy = y + barHeight / 2
    const size = Math.min(barHeight, 16) / 2
    const diamond = svgEl('polygon', {
      points: `${cx},${cy - size} ${cx + size},${cy} ${cx},${cy + size} ${cx - size},${cy}`,
      class: 'tl-gantt-milestone',
      fill: color
    })
    group.appendChild(diamond)
    const label = svgEl('text', {
      x: cx + size + 6,
      y: cy + 4,
      class: 'tl-gantt-milestone-label'
    })
    label.textContent = task.title
    group.appendChild(label)
    svg.appendChild(group)
    return
  }

  const rect = svgEl('rect', {
    x,
    y,
    width,
    height: barHeight,
    rx: 6,
    class: 'tl-gantt-bar',
    fill: color
  })
  group.appendChild(rect)

  if (task.progress) {
    group.appendChild(
      svgEl('rect', {
        x,
        y,
        width: (width * Math.min(100, task.progress)) / 100,
        height: barHeight,
        rx: 6,
        class: 'tl-gantt-bar-progress'
      })
    )
  }

  const label = svgEl('text', {
    x: x + 8,
    y: y + barHeight / 2 + 4,
    class: 'tl-gantt-bar-label'
  })
  label.textContent = task.title
  group.appendChild(label)

  const startHandle = svgEl('rect', {
    x,
    y,
    width: 6,
    height: barHeight,
    class: 'tl-gantt-handle'
  })
  const endHandle = svgEl('rect', {
    x: x + width - 6,
    y,
    width: 6,
    height: barHeight,
    class: 'tl-gantt-handle'
  })
  group.appendChild(startHandle)
  group.appendChild(endHandle)

  const begin = (mode: DragMode) => (event: PointerEvent) => {
    event.preventDefault()
    event.stopPropagation()
    drag.current = {
      task,
      mode,
      originX: event.clientX,
      startDay: bounds.start,
      endDay: bounds.end,
      rect
    }
    document.body.addClass('tl-dragging')
  }

  const moveHandler = begin('move')
  const startHandler = begin('resize-start')
  const endHandler = begin('resize-end')
  rect.addEventListener('pointerdown', moveHandler)
  startHandle.addEventListener('pointerdown', startHandler)
  endHandle.addEventListener('pointerdown', endHandler)
  cleanups.push(() => {
    rect.removeEventListener('pointerdown', moveHandler)
    startHandle.removeEventListener('pointerdown', startHandler)
    endHandle.removeEventListener('pointerdown', endHandler)
  })

  rect.addEventListener('dblclick', () => openTaskModal(plugin, task))

  svg.appendChild(group)
}

function renderArrows(
  svg: SVGSVGElement,
  plugin: TruelinePlugin,
  timeline: Timeline,
  rows: Task[]
): void {
  const rowIndex = new Map<string, number>()
  rows.forEach((task, index) => rowIndex.set(task.path, index))

  const defs = svgEl('defs')
  const marker = svgEl('marker', {
    id: 'tl-arrowhead',
    markerWidth: 8,
    markerHeight: 8,
    refX: 6,
    refY: 3,
    orient: 'auto'
  })
  marker.appendChild(svgEl('path', { d: 'M0,0 L0,6 L8,3 z', class: 'tl-gantt-arrowhead' }))
  defs.appendChild(marker)
  svg.appendChild(defs)

  const group = svgEl('g', { class: 'tl-gantt-arrows' })

  for (const task of rows) {
    const toRow = rowIndex.get(task.path)
    const bounds = span(task)
    if (toRow === undefined || !bounds) continue
    const toX = dateToX(timeline, bounds.start)
    const toY = toRow * ROW_HEIGHT + ROW_HEIGHT / 2

    for (const dep of task.blockedBy) {
      const blocker = plugin.tasks.resolve(dep.uid, task.path)
      if (!blocker) continue
      const fromRow = rowIndex.get(blocker.path)
      const blockerBounds = span(blocker)
      if (fromRow === undefined || !blockerBounds) continue

      const anchorDay =
        dep.reltype === 'STARTTOSTART' || dep.reltype === 'STARTTOFINISH'
          ? blockerBounds.start
          : blockerBounds.end + 1
      const fromX = dateToX(timeline, anchorDay)
      const fromY = fromRow * ROW_HEIGHT + ROW_HEIGHT / 2
      const midX = (fromX + toX) / 2

      group.appendChild(
        svgEl('path', {
          d: `M ${fromX} ${fromY} C ${midX} ${fromY}, ${midX} ${toY}, ${toX} ${toY}`,
          class: 'tl-gantt-arrow',
          'marker-end': 'url(#tl-arrowhead)'
        })
      )
    }
  }
  svg.appendChild(group)
}

async function commit(
  plugin: TruelinePlugin,
  autoSchedule: boolean,
  task: Task,
  startDay: number,
  endDay: number
): Promise<void> {
  await plugin.tasks.update(task.path, {
    scheduled: fromDay(startDay),
    due: fromDay(endDay)
  })

  if (!autoSchedule) return

  const result = reschedule(
    plugin.tasks.all(),
    (uid, source) => plugin.tasks.resolve(uid, source),
    task.path
  )

  if (result.cycle.length) {
    new Notice(
      `Dependencia circular detectada (${result.cycle.length} tareas). No se reprogramó nada.`
    )
    return
  }

  for (const change of result.changes) {
    await plugin.tasks.update(change.path, {
      ...(change.scheduled ? { scheduled: change.scheduled } : {}),
      ...(change.due ? { due: change.due } : {})
    })
  }

  if (result.changes.length) {
    new Notice(`Se reprogramaron ${result.changes.length} tareas dependientes.`)
  }
}
