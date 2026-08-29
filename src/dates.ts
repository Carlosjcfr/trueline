/**
 * Civil-date arithmetic.
 *
 * The Gantt needs to count days between calendar dates, and `Date` is the wrong tool
 * for that: it carries a timezone, so "2026-03-29 plus one day" can land back on the
 * same day across a DST boundary and the bar ends up one pixel column short. Everything
 * here works on a day number — days since the epoch — which has no such failure mode.
 */

export type DayNumber = number

const MS_PER_DAY = 86_400_000

/** `YYYY-MM-DD` (a longer datetime is truncated) to a day number. */
export function toDay(value: string | undefined): DayNumber | null {
  if (!value) return null
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  if (!match) return null
  const [, y, m, d] = match
  return Math.floor(Date.UTC(Number(y), Number(m) - 1, Number(d)) / MS_PER_DAY)
}

export function fromDay(day: DayNumber): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10)
}

export function todayDay(): DayNumber {
  const now = new Date()
  return Math.floor(
    Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / MS_PER_DAY
  )
}

/** Monday = 1 … Sunday = 7, matching ISO. */
export function dayOfWeek(day: DayNumber): number {
  const jsDay = new Date(day * MS_PER_DAY).getUTCDay()
  return jsDay === 0 ? 7 : jsDay
}

export function dayOfMonth(day: DayNumber): number {
  return new Date(day * MS_PER_DAY).getUTCDate()
}

/** 1–12. */
export function monthOf(day: DayNumber): number {
  return new Date(day * MS_PER_DAY).getUTCMonth() + 1
}

export function yearOf(day: DayNumber): number {
  return new Date(day * MS_PER_DAY).getUTCFullYear()
}

export function startOfMonth(day: DayNumber): DayNumber {
  const date = new Date(day * MS_PER_DAY)
  return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / MS_PER_DAY)
}

/** ISO week number, ISO-8601 rules (week 1 contains the first Thursday). */
export function weekNumber(day: DayNumber): number {
  const thursday = day + (4 - dayOfWeek(day))
  const year = yearOf(thursday)
  const jan1 = Math.floor(Date.UTC(year, 0, 1) / MS_PER_DAY)
  return Math.floor((thursday - jan1) / 7) + 1
}

const MONTH_NAMES = [
  'ene', 'feb', 'mar', 'abr', 'may', 'jun',
  'jul', 'ago', 'sep', 'oct', 'nov', 'dic'
]

export function monthLabel(day: DayNumber): string {
  return `${MONTH_NAMES[monthOf(day) - 1]} ${yearOf(day)}`
}

export function quarterLabel(day: DayNumber): string {
  return `T${Math.floor((monthOf(day) - 1) / 3) + 1} ${yearOf(day)}`
}

/**
 * ISO 8601 duration to a whole number of days. Only the units a dependency gap can
 * sensibly use are honoured; hours and below round to zero because the timeline's
 * smallest unit is a day, and pretending otherwise would move bars by a fraction of a
 * column that the user cannot see or undo.
 */
export function durationToDays(value: string | undefined): number {
  if (!value) return 0
  const match = /^(-)?P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?/.exec(value.trim())
  if (!match) return 0
  const [, sign, years, months, weeks, days] = match
  const total =
    Number(years ?? 0) * 365 +
    Number(months ?? 0) * 30 +
    Number(weeks ?? 0) * 7 +
    Number(days ?? 0)
  return sign === '-' ? -total : total
}

export function daysToDuration(days: number): string | undefined {
  if (!days) return undefined
  return days < 0 ? `-P${Math.abs(days)}D` : `P${days}D`
}
