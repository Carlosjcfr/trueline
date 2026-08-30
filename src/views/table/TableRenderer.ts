/**
 * The table view.
 *
 * Rows are grouped by their parent so subtasks sit under the task they belong to, with
 * the tree derived from `projects` links rather than a stored order. Sorting therefore
 * applies within a level, never across the whole flat list — otherwise a subtask can
 * float above its parent and the indentation starts lying.
 */

import { setIcon } from 'obsidian'
import type ProjectNotesPlugin from '../../main'
import type { Task } from '../../types'
import { nextStatus } from '../../settings'
import { openTaskModal } from '../../modals/TaskModal'
import { Chip } from '../../ui/primitives/Chip'
import { ProgressBar } from '../../ui/primitives/ProgressBar'
import { AvatarStack } from '../../ui/primitives/AvatarStack'
import { formatMinutes, isRunning, trackedMinutes } from '../../store/timer'

interface Node {
  task: Task
  children: Node[]
}

export function renderTable(
  container: HTMLElement,
  plugin: ProjectNotesPlugin,
  tasks: Task[],
  projectPath: string | undefined
): void {
  const config = plugin.projects.resolve(projectPath)
  const table = container.createEl('table', { cls: 'pn-table' })

  const head = table.createEl('thead').createEl('tr')
  for (const label of [
    '',
    'Tarea',
    'Estado',
    'Prioridad',
    'Inicio',
    'Vence',
    'Tiempo',
    'Progreso',
    'Asignados'
  ]) {
    head.createEl('th', { text: label })
  }

  const body = table.createEl('tbody')
  const roots = buildTree(plugin, tasks)

  if (roots.length === 0) {
    const row = body.createEl('tr').createEl('td', { attr: { colspan: '9' } })
    row.createDiv('pn-empty-state').setText('No hay tareas todavía.')
    return
  }

  const renderNode = (node: Node, depth: number): void => {
    const row = body.createEl('tr', { cls: 'pn-table-row' })

    const statusCell = row.createEl('td', { cls: 'pn-cell-status-icon' })
    const status = config.statuses.find((s) => s.id === node.task.status)
    const toggle = statusCell.createSpan({ cls: 'pn-status-toggle' })
    setIcon(toggle, status?.icon ?? 'circle')
    toggle.style.color = status?.color ?? 'var(--text-muted)'
    toggle.addEventListener('click', () => {
      void plugin.tasks.update(node.task.path, {
        status: nextStatus(config.statuses, node.task.status)
      })
    })

    const titleCell = row.createEl('td', { cls: 'pn-cell-title' })
    titleCell.style.paddingLeft = `${depth * 18 + 8}px`
    if (node.task.milestone) {
      setIcon(titleCell.createSpan({ cls: 'pn-milestone-icon' }), 'diamond')
    }
    if (node.task.recurrence) {
      setIcon(titleCell.createSpan({ cls: 'pn-row-icon' }), 'repeat')
    }
    const link = titleCell.createSpan({ cls: 'pn-task-link', text: node.task.title })
    link.addEventListener('click', () => openTaskModal(plugin, node.task))

    const statusText = row.createEl('td')
    if (status) {
      new Chip(statusText).setLabel(status.label).setVariant('solid').setColor(status.color)
    }

    const priorityCell = row.createEl('td')
    const priority = config.priorities.find((p) => p.id === node.task.priority)
    if (priority) {
      new Chip(priorityCell).setLabel(priority.label).setVariant('outline').setColor(priority.color)
    }

    row.createEl('td', { text: dateLabel(node.task.scheduled) })
    const dueCell = row.createEl('td', { text: dateLabel(node.task.due) })
    if (isOverdue(node.task, config.statuses)) dueCell.addClass('pn-cell-overdue')

    // Time cell doubles as the play/pause control: starting a timer is the most
    // frequent action on a list of tasks, and it should not need a modal.
    const timeCell = row.createEl('td', { cls: 'pn-cell-time' })
    const running = isRunning(node.task)
    const timerToggle = timeCell.createSpan({
      cls: `pn-row-timer${running ? ' pn-row-timer--running' : ''}`
    })
    setIcon(timerToggle, running ? 'pause' : 'play')
    timerToggle.addEventListener('click', (event) => {
      event.stopPropagation()
      void plugin.timer.toggle(node.task)
    })
    const minutes = trackedMinutes(node.task)
    if (minutes > 0) {
      timeCell.createSpan({ cls: 'pn-row-time-total', text: formatMinutes(minutes) })
    }

    const progressCell = row.createEl('td', { cls: 'pn-cell-progress' })
    new ProgressBar(progressCell).setValue(node.task.progress ?? 0).setSize('sm')

    const assigneeCell = row.createEl('td')
    if (node.task.assignees.length) {
      new AvatarStack(assigneeCell).setNames(node.task.assignees).setSize('sm')
    }

    for (const child of node.children) renderNode(child, depth + 1)
  }

  for (const root of roots) renderNode(root, 0)
}

/**
 * Builds the parent/child forest. A task whose parent is outside the current filter is
 * promoted to a root rather than hidden — dropping it would make the count wrong and
 * the missing row impossible to explain.
 */
function buildTree(plugin: ProjectNotesPlugin, tasks: Task[]): Node[] {
  const nodes = new Map<string, Node>()
  for (const task of tasks) nodes.set(task.path, { task, children: [] })

  const roots: Node[] = []
  for (const node of nodes.values()) {
    let attached = false
    for (const ref of node.task.projects) {
      const parent = plugin.tasks.resolve(ref, node.task.path)
      const parentNode = parent ? nodes.get(parent.path) : undefined
      if (parentNode && parentNode !== node) {
        parentNode.children.push(node)
        attached = true
        break
      }
    }
    if (!attached) roots.push(node)
  }

  const byDue = (a: Node, b: Node): number =>
    (a.task.due ?? '9999').localeCompare(b.task.due ?? '9999')
  const sortDeep = (list: Node[]): void => {
    list.sort(byDue)
    for (const node of list) sortDeep(node.children)
  }
  sortDeep(roots)
  return roots
}

function dateLabel(value: string | undefined): string {
  return value ? value.slice(0, 10) : '—'
}

function isOverdue(task: Task, statuses: { id: string; complete: boolean }[]): boolean {
  if (!task.due) return false
  if (statuses.find((s) => s.id === task.status)?.complete) return false
  return task.due.slice(0, 10) < new Date().toISOString().slice(0, 10)
}
