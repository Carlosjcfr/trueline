/**
 * The vault-wide timer.
 *
 * Two responsibilities:
 *
 *  1. **One timer at a time.** Starting a task stops whatever else was running. The
 *     alternative - several open sessions - produces time reports that add up to more
 *     hours than exist in the day, and nobody notices until invoicing.
 *
 *  2. **The status bar.** A running timer has to be visible from anywhere in Obsidian,
 *     or you forget it is on and log eleven hours of "revisar dietas". Clicking the
 *     widget opens the task; the pause button stops it without leaving what you are
 *     doing.
 *
 * The ticking is display-only: it re-renders a label once a second and writes nothing.
 * The note is touched exactly twice per session, on start and on stop.
 */

import { Notice, setIcon, setTooltip, type App } from 'obsidian'
import type { Task } from '../types'
import type { TaskStore } from '../store/TaskStore'
import { elapsedMs, formatDuration, isRunning, startTimer, stopTimer } from '../store/timer'

export class TimerService {
  private statusEl: HTMLElement | null = null
  private labelEl: HTMLElement | null = null
  private tickHandle: number | null = null
  /** Path of the task whose timer is running, or null. Derived from the store on load. */
  private activePath: string | null = null

  constructor(
    private readonly app: App,
    private readonly tasks: TaskStore
  ) {}

  /** Adopts whatever session the vault says is already running. */
  adoptRunning(): void {
    const running = this.tasks.all().find(isRunning)
    this.activePath = running?.path ?? null
    this.refresh()
  }

  attachStatusBar(el: HTMLElement): void {
    this.statusEl = el
    el.addClass('pn-timer-status')

    const icon = el.createSpan({ cls: 'pn-timer-status-icon' })
    setIcon(icon, 'timer')

    this.labelEl = el.createSpan({ cls: 'pn-timer-status-label' })

    const openTask = el.createSpan({ cls: 'pn-timer-status-title' })
    openTask.addEventListener('click', () => this.openActive())

    const stop = el.createSpan({ cls: 'pn-timer-status-stop' })
    setIcon(stop, 'pause')
    setTooltip(stop, 'Pausar')
    stop.addEventListener('click', (event) => {
      event.stopPropagation()
      void this.stop()
    })

    this.refresh()
  }

  get active(): Task | undefined {
    return this.activePath ? this.tasks.get(this.activePath) : undefined
  }

  isRunning(task: Task): boolean {
    return isRunning(task)
  }

  /**
   * Starts a task, stopping any other running one first. Awaiting the stop before the
   * start matters: both are vault writes, and overlapping them can interleave into a
   * state where two sessions are briefly open.
   */
  async start(task: Task, description?: string): Promise<void> {
    const current = this.active
    if (current && current.path !== task.path) {
      await this.stop()
    }

    const fresh = this.tasks.get(task.path) ?? task
    const patch = startTimer(fresh, description)
    if (!patch) return

    await this.tasks.update(task.path, patch)
    this.activePath = task.path
    this.refresh()
  }

  async stop(): Promise<void> {
    const task = this.active
    if (!task) return

    const patch = stopTimer(task)
    this.activePath = null

    if (patch) await this.tasks.update(task.path, patch)
    this.refresh()
  }

  async toggle(task: Task): Promise<void> {
    const fresh = this.tasks.get(task.path) ?? task
    if (isRunning(fresh)) await this.stop()
    else await this.start(fresh)
  }

  /** Starts the timer on whatever task is open, for the command palette. */
  async toggleActiveFile(): Promise<void> {
    const file = this.app.workspace.getActiveFile()
    const task = file ? this.tasks.get(file.path) : undefined
    if (!task) {
      new Notice('La nota activa no es una tarea.')
      return
    }
    await this.toggle(task)
  }

  dispose(): void {
    this.stopTicking()
  }

  private refresh(): void {
    const task = this.active
    if (!this.statusEl) return

    if (!task) {
      this.statusEl.hide()
      this.stopTicking()
      return
    }

    this.statusEl.show()
    const title = this.statusEl.querySelector('.pn-timer-status-title')
    if (title instanceof HTMLElement) title.setText(task.title)
    this.tick()
    this.startTicking()
  }

  private startTicking(): void {
    if (this.tickHandle !== null) return
    this.tickHandle = window.setInterval(() => this.tick(), 1000)
  }

  private stopTicking(): void {
    if (this.tickHandle === null) return
    window.clearInterval(this.tickHandle)
    this.tickHandle = null
  }

  private tick(): void {
    const task = this.active
    if (!task || !this.labelEl) return
    this.labelEl.setText(formatDuration(elapsedMs(task), true))
  }

  private openActive(): void {
    const task = this.active
    if (!task) return
    const file = this.app.vault.getAbstractFileByPath(task.path)
    if (file) void this.app.workspace.getLeaf(false).openFile(file as never)
  }
}
