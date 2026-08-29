/**
 * Timeline geometry for the Gantt.
 *
 * Ported in shape from Project Manager's `TimelineConfig`
 * (Copyright (c) 2026 Stepan Kropachev, MIT — see licenses/obsidian-pm.LICENSE),
 * rewritten over day numbers instead of Temporal so the plugin carries no polyfill.
 */

import {
  dayOfMonth,
  dayOfWeek,
  monthOf,
  startOfMonth,
  todayDay,
  weekNumber,
  type DayNumber
} from '../../dates'
import type { Task } from '../../types'
import { toDay } from '../../dates'

export type Granularity = 'day' | 'week' | 'month' | 'quarter' | 'year'

export const ROW_HEIGHT = 40
export const HEADER_HEIGHT = 52
export const LABEL_WIDTH = 260
export const BAR_PADDING = 7

export const DAY_WIDTH: Record<Granularity, number> = {
  day: 44,
  week: 22,
  month: 9,
  quarter: 5,
  year: 2
}

/** Minimum span so a one-task project does not render as a single column. */
const MIN_DAYS: Record<Granularity, number> = {
  day: 30,
  week: 90,
  month: 365,
  quarter: 365,
  year: 1095
}

export interface Timeline {
  start: DayNumber
  end: DayNumber
  dayWidth: number
  granularity: Granularity
  totalDays: number
  totalWidth: number
}

export function buildTimeline(tasks: Task[], granularity: Granularity): Timeline {
  const days: DayNumber[] = [todayDay()]
  for (const task of tasks) {
    const scheduled = toDay(task.scheduled)
    const due = toDay(task.due)
    if (scheduled !== null) days.push(scheduled)
    if (due !== null) days.push(due)
  }

  let start = Math.min(...days) - 7
  let end = Math.max(...days) + 14

  const span = end - start
  if (span < MIN_DAYS[granularity]) {
    const extra = Math.ceil((MIN_DAYS[granularity] - span) / 2)
    start -= extra
    end += extra
  }

  // Anything coarser than days reads wrong unless the axis begins on a month boundary.
  if (granularity !== 'day') start = startOfMonth(start)

  const totalDays = end - start
  const dayWidth = DAY_WIDTH[granularity]
  return { start, end, dayWidth, granularity, totalDays, totalWidth: totalDays * dayWidth }
}

export function dateToX(timeline: Timeline, day: DayNumber): number {
  return (day - timeline.start) * timeline.dayWidth
}

export function xToDate(timeline: Timeline, x: number): DayNumber {
  return timeline.start + Math.round(x / timeline.dayWidth)
}

/**
 * Positions a drag can settle on. At coarse zoom a free-running drag cannot express
 * "the 3rd" anyway — one pixel is a fifth of a day — so the snap grid coarsens with it
 * and the user gets a date they meant rather than one they landed on.
 */
export function snapPoints(timeline: Timeline): number[] {
  const points: number[] = []
  for (let i = 0; i <= timeline.totalDays; i++) {
    const day = timeline.start + i
    const x = i * timeline.dayWidth
    switch (timeline.granularity) {
      case 'day':
        points.push(x)
        break
      case 'week':
        if (dayOfWeek(day) === 1 || dayOfWeek(day) === 4) points.push(x)
        break
      case 'month':
        if ([1, 8, 15, 22].includes(dayOfMonth(day))) points.push(x)
        break
      default:
        if (dayOfMonth(day) === 1) points.push(x)
    }
  }
  return points
}

export function snapX(x: number, points: number[], threshold: number): number {
  let closest = x
  let best = Infinity
  for (const point of points) {
    const distance = Math.abs(x - point)
    if (distance < best) {
      best = distance
      closest = point
    }
    if (point > x + threshold) break
  }
  return best <= threshold ? closest : x
}

export function isQuarterStart(day: DayNumber): boolean {
  return dayOfMonth(day) === 1 && (monthOf(day) - 1) % 3 === 0
}

export function isWeekend(day: DayNumber): boolean {
  const dow = dayOfWeek(day)
  return dow === 6 || dow === 7
}

export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {}
): SVGElementTagNameMap[K] {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag)
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value))
  return el
}

/**
 * The minor tick label under the month band, or null when the column is too narrow to
 * carry text. At month zoom a day is nine pixels wide: any label there is unreadable
 * mush, so the band is left empty rather than filled with overlapping digits.
 */
export function dayGranularityLabel(timeline: Timeline, day: DayNumber): string | null {
  switch (timeline.granularity) {
    case 'day':
      return String(dayOfMonth(day))
    case 'week':
      return dayOfWeek(day) === 1 ? `S${weekNumber(day)}` : null
    default:
      return null
  }
}
