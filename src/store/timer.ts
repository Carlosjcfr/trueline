/**
 * Time tracking, as pure functions over a task.
 *
 * A running session is an entry with `startTime` and no `endTime` (§2.6.1). Nothing
 * else records "is the timer on" - no plugin state, no data.json field. That matters
 * more than it sounds: if the app is force-quit mid-session the note already says the
 * timer was running, so the next launch picks it up instead of losing the afternoon.
 *
 * The spec allows at most one running entry per task. This module goes further and the
 * service above it enforces one running entry across the whole vault, because the thing
 * being measured is a person, and a person is working on one task at a time.
 */

import type { Task, TimeEntry } from '../types'

export function runningEntry(task: Task): TimeEntry | undefined {
  return task.timeEntries.find((entry) => !entry.endTime)
}

export function isRunning(task: Task): boolean {
  return runningEntry(task) !== undefined
}

/** Milliseconds on the currently running session, or 0 when stopped. */
export function elapsedMs(task: Task, now: number = Date.now()): number {
  const entry = runningEntry(task)
  if (!entry) return 0
  const started = Date.parse(entry.startTime)
  return Number.isFinite(started) ? Math.max(0, now - started) : 0
}

/** Total tracked minutes, closed sessions plus the one in flight. */
export function trackedMinutes(task: Task, now: number = Date.now()): number {
  let ms = 0
  for (const entry of task.timeEntries) {
    const start = Date.parse(entry.startTime)
    if (!Number.isFinite(start)) continue
    const end = entry.endTime ? Date.parse(entry.endTime) : now
    if (!Number.isFinite(end) || end < start) continue
    ms += end - start
  }
  return Math.round(ms / 60_000)
}

/** Minutes tracked on one calendar day, for the day cell in the calendar view. */
export function trackedMinutesOn(task: Task, date: string, now: number = Date.now()): number {
  let ms = 0
  for (const entry of task.timeEntries) {
    if (!entry.startTime.startsWith(date)) continue
    const start = Date.parse(entry.startTime)
    const end = entry.endTime ? Date.parse(entry.endTime) : now
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue
    ms += end - start
  }
  return Math.round(ms / 60_000)
}

/**
 * Starts a session. A no-op when one is already running, so a double click on play
 * cannot open two entries and make the task permanently invalid.
 */
export function startTimer(
  task: Task,
  description?: string,
  now: Date = new Date()
): Partial<Task> | null {
  if (isRunning(task)) return null
  const entry: TimeEntry = {
    startTime: now.toISOString(),
    ...(description ? { description } : {})
  }
  return { timeEntries: [...task.timeEntries, entry] }
}

/**
 * Stops the running session. Sessions shorter than a second are dropped rather than
 * stored: they are always a mis-click, and a log full of 0-minute rows is worse than
 * no log.
 */
export function stopTimer(task: Task, now: Date = new Date()): Partial<Task> | null {
  const entry = runningEntry(task)
  if (!entry) return null

  const start = Date.parse(entry.startTime)
  const end = now.getTime()

  if (Number.isFinite(start) && end - start < 1000) {
    return { timeEntries: task.timeEntries.filter((item) => item !== entry) }
  }

  return {
    timeEntries: task.timeEntries.map((item) =>
      item === entry ? { ...item, endTime: now.toISOString() } : item
    )
  }
}

export function removeEntry(task: Task, index: number): Partial<Task> {
  return { timeEntries: task.timeEntries.filter((_, i) => i !== index) }
}

export function updateEntry(
  task: Task,
  index: number,
  patch: Partial<TimeEntry>
): Partial<Task> {
  return {
    timeEntries: task.timeEntries.map((entry, i) =>
      i === index ? { ...entry, ...patch } : entry
    )
  }
}

/** Adds a finished session by hand, for time worked away from the keyboard. */
export function addManualEntry(
  task: Task,
  date: string,
  minutes: number,
  description?: string
): Partial<Task> {
  const start = new Date(`${date}T09:00:00`)
  const end = new Date(start.getTime() + minutes * 60_000)
  return {
    timeEntries: [
      ...task.timeEntries,
      {
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        ...(description ? { description } : {})
      }
    ]
  }
}

/** `1h 05m`, or `05:32` while a session is running and seconds still matter. */
export function formatDuration(ms: number, withSeconds = false): string {
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (withSeconds) {
    return hours > 0
      ? `${hours}:${pad(minutes)}:${pad(seconds)}`
      : `${pad(minutes)}:${pad(seconds)}`
  }
  if (hours === 0) return `${minutes}m`
  return `${hours}h ${pad(minutes)}m`
}

export function formatMinutes(minutes: number): string {
  return formatDuration(minutes * 60_000)
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}
