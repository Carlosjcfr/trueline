/**
 * Kanban board.
 *
 * Columns come from the project's status catalog, so a project that declares its own
 * statuses gets its own columns without any board-level configuration.
 *
 * Dropping a card does two writes at most — the card's status and its rank — never a
 * renumbering pass over the column. See `store/rank.ts` for why that matters in a vault.
 *
 * Drag uses the HTML5 drag-and-drop API rather than pointer events: it is the only one
 * that keeps working when a drag crosses into a scrolling container, which a Kanban
 * column always is.
 */

import { setIcon } from 'obsidian'
import type ProjectNotesPlugin from '../../main'
import type { ResolvedProjectConfig, Task } from '../../types'
import { openTaskModal } from '../../modals/TaskModal'
import { byRank, rankBetween } from '../../store/rank'
import { Chip } from '../../ui/primitives/Chip'
import { ProgressBar } from '../../ui/primitives/ProgressBar'
import { AvatarStack } from '../../ui/primitives/AvatarStack'
import { toDay, todayDay } from '../../dates'
import { formatMinutes, isRunning, trackedMinutes } from '../../store/timer'

interface DragPayload {
  path: string
  fromStatus: string
}

let dragging: DragPayload | null = null

export function renderKanban(
  container: HTMLElement,
  plugin: ProjectNotesPlugin,
  tasks: Task[],
  projectPath: string | undefined
): void {
  const config = plugin.projects.resolve(projectPath)
  const board = container.createDiv('pn-kanban')

  const byStatus = new Map<string, Task[]>()
  for (const status of config.statuses) byStatus.set(status.id, [])
  for (const task of tasks) {
    // A status the catalog no longer knows about still has to go somewhere, or the
    // card silently vanishes from the board and the user thinks the task was deleted.
    const bucket = byStatus.get(task.status) ?? byStatus.get(config.statuses[0]?.id ?? '')
    bucket?.push(task)
  }

  for (const status of config.statuses) {
    const column = board.createDiv('pn-kanban-col')
    const cards = (byStatus.get(status.id) ?? []).slice().sort(byRank)

    const header = column.createDiv('pn-kanban-col-header')
    const dot = header.createSpan({ cls: 'pn-kanban-col-dot' })
    dot.style.background = status.color
    header.createSpan({ cls: 'pn-kanban-col-title', text: status.label })
    header.createSpan({ cls: 'pn-kanban-col-count', text: String(cards.length) })

    const list = column.createDiv('pn-kanban-list')
    list.dataset.status = status.id

    for (const task of cards) renderCard(list, plugin, task, config)

    // The drop indicator is a single reused element: creating one per dragover is what
    // makes naive Kanban implementations flicker.
    const indicator = list.createDiv('pn-kanban-drop-indicator')
    indicator.hide()

    list.addEventListener('dragover', (event) => {
      if (!dragging) return
      event.preventDefault()
      const before = cardBefore(list, event.clientY)
      indicator.show()
      if (before) list.insertBefore(indicator, before)
      else list.appendChild(indicator)
    })

    list.addEventListener('dragleave', (event) => {
      if (event.target === list) indicator.hide()
    })

    list.addEventListener('drop', (event) => {
      if (!dragging) return
      event.preventDefault()
      indicator.hide()
      const payload = dragging
      dragging = null

      const ordered = [...list.querySelectorAll<HTMLElement>('.pn-kanban-card')]
        .map((el) => el.dataset.path)
        .filter((path): path is string => Boolean(path) && path !== payload.path)

      const insertIndex = indexFor(list, indicator, ordered)
      const rankOf = (index: number): string | undefined => {
        const path = ordered[index]
        return path ? plugin.tasks.get(path)?.rank : undefined
      }

      void plugin.tasks.update(payload.path, {
        status: status.id,
        rank: rankBetween(rankOf(insertIndex - 1), rankOf(insertIndex))
      })
    })
  }
}

function renderCard(
  list: HTMLElement,
  plugin: ProjectNotesPlugin,
  task: Task,
  config: ResolvedProjectConfig
): void {
  const card = list.createDiv('pn-kanban-card')
  card.dataset.path = task.path
  card.draggable = true

  card.addEventListener('dragstart', (event) => {
    dragging = { path: task.path, fromStatus: task.status }
    card.addClass('pn-kanban-card--dragging')
    event.dataTransfer?.setData('text/plain', task.path)
  })
  card.addEventListener('dragend', () => {
    card.removeClass('pn-kanban-card--dragging')
    dragging = null
  })

  const top = card.createDiv('pn-kanban-card-top')
  if (task.milestone) setIcon(top.createSpan({ cls: 'pn-milestone-icon' }), 'diamond')
  if (task.recurrence) setIcon(top.createSpan({ cls: 'pn-row-icon' }), 'repeat')
  const title = top.createSpan({ cls: 'pn-kanban-card-title', text: task.title })
  title.addEventListener('click', () => openTaskModal(plugin, task))

  const running = isRunning(task)
  const timer = top.createSpan({
    cls: `pn-row-timer pn-kanban-card-timer${running ? ' pn-row-timer--running' : ''}`
  })
  setIcon(timer, running ? 'pause' : 'play')
  timer.addEventListener('click', (event) => {
    event.stopPropagation()
    void plugin.timer.toggle(task)
  })

  const meta = card.createDiv('pn-kanban-card-meta')

  const minutes = trackedMinutes(task)
  if (minutes > 0) {
    meta.createSpan({ cls: 'pn-kanban-time', text: formatMinutes(minutes) })
  }

  const priority = config.priorities.find((p) => p.id === task.priority)
  if (priority) {
    new Chip(meta).setLabel(priority.label).setVariant('outline').setColor(priority.color)
  }
  for (const tag of task.tags.slice(0, 3)) {
    new Chip(meta).setLabel(tag).setVariant('plain').el.addClass('pn-chip--tag')
  }
  if (task.ghIssue) {
    const chip = new Chip(meta).setLabel(task.ghIssue.split('#')[1] ?? '')
    chip.setVariant('plain')
    setIcon(chip.el.createSpan({ cls: 'pn-chip-icon' }), 'github')
  }

  if (task.due) {
    const due = meta.createSpan({ cls: 'pn-kanban-due', text: task.due.slice(0, 10) })
    const dueDay = toDay(task.due)
    const complete = config.statuses.find((s) => s.id === task.status)?.complete
    if (dueDay !== null && dueDay < todayDay() && !complete) due.addClass('pn-cell-overdue')
  }

  if (task.progress !== undefined && task.progress > 0) {
    new ProgressBar(card.createDiv('pn-kanban-card-progress'))
      .setValue(task.progress)
      .setSize('sm')
  }

  if (task.assignees.length) {
    new AvatarStack(card.createDiv('pn-kanban-card-people'))
      .setNames(task.assignees)
      .setSize('sm')
  }
}

/** The first card whose midpoint is below the pointer — where the drop should land. */
function cardBefore(list: HTMLElement, clientY: number): HTMLElement | null {
  const cards = [...list.querySelectorAll<HTMLElement>('.pn-kanban-card:not(.pn-kanban-card--dragging)')]
  for (const card of cards) {
    const box = card.getBoundingClientRect()
    if (clientY < box.top + box.height / 2) return card
  }
  return null
}

function indexFor(list: HTMLElement, indicator: HTMLElement, ordered: string[]): number {
  const children = [...list.children]
  const indicatorIndex = children.indexOf(indicator)
  if (indicatorIndex < 0) return ordered.length
  let index = 0
  for (let i = 0; i < indicatorIndex; i++) {
    const child = children[i]
    if (child instanceof HTMLElement && child.hasClass('pn-kanban-card')) {
      const path = child.dataset.path
      if (path && ordered.includes(path)) index++
    }
  }
  return index
}
