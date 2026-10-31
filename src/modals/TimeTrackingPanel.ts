/**
 * The time-tracking panel of the task modal.
 *
 * Unlike every other control in the modal, these write straight through to the vault
 * instead of into the draft that commits on Save. A timer is a measurement of real
 * elapsed time: if pressing play only took effect on Save, cancelling the modal would
 * silently discard work you actually did, and closing Obsidian mid-session would lose
 * it entirely. So play, pause and every edit to a session are immediate.
 */

import { Notice, setIcon, setTooltip } from 'obsidian'
import type TruelinePlugin from '../main'
import type { Task } from '../types'
import {
  addManualEntry,
  elapsedMs,
  formatDuration,
  formatMinutes,
  isRunning,
  removeEntry,
  trackedMinutes,
  updateEntry
} from '../store/timer'

export interface TimePanelOptions {
  plugin: TruelinePlugin
  /** Re-read from the store; the draft's own copy of timeEntries is now stale. */
  onChange: () => void
}

export function renderTimePanel(
  container: HTMLElement,
  task: Task,
  options: TimePanelOptions
): () => void {
  const { plugin, onChange } = options
  const panel = container.createDiv('tl-time-panel')
  const running = isRunning(task)

  // -- header: play/pause, running total, estimate ---------------------------
  const header = panel.createDiv('tl-time-header')

  const button = header.createEl('button', {
    cls: `tl-time-toggle${running ? ' tl-time-toggle--running' : ''}`
  })
  setIcon(button, running ? 'pause' : 'play')
  setTooltip(button, running ? 'Pausar' : 'Iniciar')
  button.addEventListener('click', async () => {
    await plugin.timer.toggle(task)
    onChange()
  })

  const live = header.createSpan({ cls: 'tl-time-live' })
  const totals = header.createSpan({ cls: 'tl-time-totals' })

  const paint = (): void => {
    const current = plugin.tasks.get(task.path) ?? task
    const tracked = trackedMinutes(current)
    live.setText(isRunning(current) ? formatDuration(elapsedMs(current), true) : '')
    live.toggleClass('tl-time-live--on', isRunning(current))

    const estimate = current.timeEstimate
    totals.setText(
      estimate
        ? `${formatMinutes(tracked)} de ${formatMinutes(estimate)}`
        : formatMinutes(tracked)
    )
    // Over estimate is worth seeing at a glance, not buried in a report.
    totals.toggleClass('tl-time-over', Boolean(estimate) && tracked > (estimate ?? 0))
  }
  paint()

  // Only ticks while a session is open; a stopped task costs nothing.
  const handle = isRunning(task) ? window.setInterval(paint, 1000) : null

  // -- sessions --------------------------------------------------------------
  if (task.timeEntries.length) {
    const list = panel.createDiv('tl-time-list')
    task.timeEntries.forEach((entry, index) => {
      const row = list.createDiv('tl-time-row')
      const open = !entry.endTime

      const start = new Date(entry.startTime)
      const end = entry.endTime ? new Date(entry.endTime) : null
      const minutes = end ? Math.round((end.getTime() - start.getTime()) / 60_000) : 0

      row.createSpan({
        cls: 'tl-time-row-date',
        text: entry.startTime.slice(0, 10)
      })
      row.createSpan({
        cls: 'tl-time-row-span',
        text: `${clock(start)}–${end ? clock(end) : '…'}`
      })
      row.createSpan({
        cls: `tl-time-row-len${open ? ' tl-time-live--on' : ''}`,
        text: open ? 'en curso' : formatMinutes(minutes)
      })

      const note = row.createEl('input', {
        cls: 'tl-time-row-note',
        attr: { type: 'text', placeholder: 'Nota' }
      })
      note.value = entry.description ?? ''
      note.addEventListener('change', async () => {
        await plugin.tasks.update(
          task.path,
          updateEntry(task, index, { description: note.value.trim() || undefined })
        )
        onChange()
      })

      const remove = row.createSpan({ cls: 'tl-time-row-remove' })
      setIcon(remove, 'trash-2')
      setTooltip(remove, 'Eliminar sesión')
      remove.addEventListener('click', async () => {
        await plugin.tasks.update(task.path, removeEntry(task, index))
        onChange()
      })
    })
  }

  // -- manual entry ----------------------------------------------------------
  const manual = panel.createDiv('tl-time-manual')
  const dateInput = manual.createEl('input', { attr: { type: 'date' } })
  dateInput.value = new Date().toISOString().slice(0, 10)
  const minutesInput = manual.createEl('input', {
    attr: { type: 'number', min: '1', step: '5', placeholder: 'min' }
  })
  const noteInput = manual.createEl('input', {
    attr: { type: 'text', placeholder: 'Nota (opcional)' }
  })
  const add = manual.createEl('button', { text: 'Añadir sesión' })
  add.addEventListener('click', async () => {
    const minutes = Number(minutesInput.value)
    if (!Number.isFinite(minutes) || minutes <= 0) {
      new Notice('Indica cuántos minutos.')
      return
    }
    await plugin.tasks.update(
      task.path,
      addManualEntry(task, dateInput.value, minutes, noteInput.value.trim() || undefined)
    )
    onChange()
  })

  return () => {
    if (handle !== null) window.clearInterval(handle)
  }
}

function clock(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
