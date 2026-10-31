/**
 * The project workspace: a header with the view switcher, and one of the views below.
 *
 * Only the table is implemented so far. The switcher is already wired for the other
 * three so that adding them is a matter of dropping in a renderer, not restructuring
 * the view — the Gantt in particular is the expensive one and should land last.
 */

import { ItemView, setIcon, type WorkspaceLeaf } from 'obsidian'
import type TruelinePlugin from '../main'
import type { Task, ViewMode } from '../types'
import { renderTable } from './table/TableRenderer'
import { renderKanban } from './kanban/KanbanView'
import { renderGantt } from './gantt/GanttView'
import type { Granularity } from './gantt/timeline'
import { renderCalendar, type CalendarScope } from './calendar/CalendarView'
import { todayDay } from '../dates'

export const PROJECT_VIEW_TYPE = 'trueline-project-view'

const VIEW_MODES: { id: ViewMode; label: string; icon: string; ready: boolean }[] = [
  { id: 'table', label: 'Tabla', icon: 'table', ready: true },
  { id: 'kanban', label: 'Kanban', icon: 'columns-3', ready: true },
  { id: 'gantt', label: 'Gantt', icon: 'chart-gantt', ready: true },
  { id: 'calendar', label: 'Calendario', icon: 'calendar', ready: true }
]

export class ProjectView extends ItemView {
  private mode: ViewMode = 'table'
  private unsubscribe: (() => void) | null = null
  private projectPath: string | undefined
  private granularity: Granularity = 'week'
  private calendarScope: CalendarScope = 'month'
  private calendarAnchor = todayDay()
  /** Torn down before every re-render; the Gantt registers window listeners. */
  private disposeView: (() => void) | null = null

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: TruelinePlugin
  ) {
    super(leaf)
  }

  override getViewType(): string {
    return PROJECT_VIEW_TYPE
  }

  override getDisplayText(): string {
    const project = this.projectPath
      ? this.plugin.projects.get(this.projectPath)
      : undefined
    return project ? project.title : 'Trueline'
  }

  override getIcon(): string {
    return 'kanban-square'
  }

  override async onOpen(): Promise<void> {
    this.mode = this.plugin.settings.defaultView
    // One subscription for the life of the view. Re-rendering on every store change is
    // affordable because the store hands us plain objects and the table is virtual-free
    // at this size; the day it is not, this is the single place to add diffing.
    this.unsubscribe = this.plugin.tasks.subscribe(() => this.render())
    this.render()
  }

  override async onClose(): Promise<void> {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.disposeView?.()
    this.disposeView = null
  }

  private render(): void {
    this.disposeView?.()
    this.disposeView = null

    const container = this.contentEl
    container.empty()
    container.addClass('tl-view')

    this.renderHeader(container)

    const body = container.createDiv('tl-view-body')
    const tasks = this.visibleTasks()

    if (this.mode === 'table') {
      renderTable(body, this.plugin, tasks, this.projectPath)
      return
    }

    if (this.mode === 'kanban') {
      renderKanban(body, this.plugin, tasks, this.projectPath)
      return
    }

    if (this.mode === 'gantt') {
      this.disposeView = renderGantt(
        body,
        this.plugin,
        tasks,
        this.projectPath,
        this.granularity,
        (next) => {
          this.granularity = next
          this.render()
        }
      )
      return
    }

    if (this.mode === 'calendar') {
      renderCalendar(
        body,
        this.plugin,
        tasks,
        this.projectPath,
        this.calendarScope,
        this.calendarAnchor,
        (scope, anchor) => {
          this.calendarScope = scope
          this.calendarAnchor = anchor
          this.render()
        }
      )
      return
    }

    const pending = body.createDiv('tl-empty-state')
    setIcon(pending.createDiv('tl-empty-icon'), 'hammer')
    pending.createEl('p', {
      text: `La vista ${labelFor(this.mode)} todavía no está implementada.`
    })
  }

  private renderHeader(container: HTMLElement): void {
    const header = container.createDiv('tl-view-header')

    const picker = header.createEl('select', { cls: 'dropdown tl-project-picker' })
    picker.createEl('option', { value: '', text: 'Todas las tareas' })
    for (const project of this.plugin.projects.all()) {
      picker.createEl('option', { value: project.path, text: project.title })
    }
    picker.value = this.projectPath ?? ''
    picker.addEventListener('change', () => {
      this.projectPath = picker.value || undefined
      this.render()
    })

    const switcher = header.createDiv('tl-view-switcher')
    for (const mode of VIEW_MODES) {
      const button = switcher.createEl('button', {
        cls: `tl-view-btn${this.mode === mode.id ? ' tl-view-btn--active' : ''}`,
        attr: { 'aria-label': mode.label }
      })
      setIcon(button.createSpan(), mode.icon)
      button.createSpan({ text: mode.label })
      if (!mode.ready) button.addClass('tl-view-btn--pending')
      button.addEventListener('click', () => {
        this.mode = mode.id
        this.render()
      })
    }

    const add = header.createEl('button', { cls: 'mod-cta', text: '+ Tarea' })
    add.addEventListener('click', () => void this.createTask())
  }

  private visibleTasks(): Task[] {
    const all = this.plugin.tasks.all().filter((task) => !task.archived)
    if (!this.projectPath) return all
    const inProject = new Set(
      this.plugin.tasks.childrenOf(this.projectPath).map((task) => task.path)
    )
    return all.filter((task) => inProject.has(task.path))
  }

  private async createTask(): Promise<void> {
    const { createTask } = await import('../store/create')
    const project = this.projectPath
      ? this.plugin.projects.get(this.projectPath)
      : undefined
    await createTask(this.app, this.plugin.settings, {
      projects: project ? [`[[${basename(project.path)}]]`] : []
    })
  }
}

function labelFor(mode: ViewMode): string {
  return VIEW_MODES.find((m) => m.id === mode)?.label ?? mode
}

function basename(path: string): string {
  const file = path.split('/').pop() ?? path
  return file.endsWith('.md') ? file.slice(0, -3) : file
}
