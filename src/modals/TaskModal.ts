/**
 * The task editor.
 *
 * Layout follows Project Manager: a title line, then a property grid of label/value
 * rows, then the panels. What changed is underneath — every control writes a semantic
 * role through the store, so the file stays spec-shaped whichever plugin opens it next.
 *
 * `Type` is a control with no field behind it: choosing Milestone sets `milestone`,
 * choosing Subtask asks for a parent and writes it into `projects`. The type is always
 * derived from the data, so it can never disagree with it.
 */

import { Modal, Setting, setIcon } from 'obsidian'
import type ProjectNotesPlugin from '../main'
import type { CustomFieldDef, Task, TaskType } from '../types'
import { isCompleteStatus } from '../settings'
import { renderPropRow } from '../ui/FormField'
import { Chip } from '../ui/primitives/Chip'
import { ProgressBar } from '../ui/primitives/ProgressBar'
import { AvatarStack } from '../ui/primitives/AvatarStack'
import { linkLabel } from '../store/links'

export function openTaskModal(plugin: ProjectNotesPlugin, task: Task): void {
  new TaskModal(plugin, task).open()
}

/** The type a task has, read off its data rather than a stored label. */
export function taskType(plugin: ProjectNotesPlugin, task: Task): TaskType {
  if (task.milestone) return 'milestone'
  for (const ref of task.projects) {
    if (plugin.tasks.resolve(ref, task.path)) return 'subtask'
  }
  return 'task'
}

class TaskModal extends Modal {
  /** Edits accumulate here and commit on save, so Escape really cancels. */
  private draft: Task

  constructor(
    private readonly plugin: ProjectNotesPlugin,
    private readonly task: Task
  ) {
    super(plugin.app)
    this.draft = structuredClone(task)
  }

  override onOpen(): void {
    this.modalEl.addClass('pn-task-modal')
    this.render()
  }

  private render(): void {
    const { contentEl } = this
    contentEl.empty()

    const config = this.plugin.projects.resolve(this.primaryProjectPath())

    // -- title -------------------------------------------------------------
    const titleInput = contentEl.createEl('input', {
      cls: 'pn-task-title',
      attr: { type: 'text', placeholder: 'Título de la tarea' }
    })
    titleInput.value = this.draft.title
    titleInput.addEventListener('input', () => {
      this.draft.title = titleInput.value
    })

    const grid = contentEl.createDiv('pn-prop-grid')

    // -- status ------------------------------------------------------------
    renderPropRow(
      grid,
      'Estado',
      () => {
        const wrap = createDiv('pn-prop-value')
        const select = wrap.createEl('select', { cls: 'dropdown' })
        for (const status of config.statuses) {
          select.createEl('option', { value: status.id, text: status.label })
        }
        select.value = this.draft.status
        select.addEventListener('change', () => {
          this.draft.status = select.value
          this.stampCompletion(config.statuses)
        })
        return wrap
      },
      'circle-dot'
    )

    // -- priority ----------------------------------------------------------
    renderPropRow(
      grid,
      'Prioridad',
      () => {
        const wrap = createDiv('pn-prop-value')
        const select = wrap.createEl('select', { cls: 'dropdown' })
        select.createEl('option', { value: '', text: '—' })
        for (const priority of config.priorities) {
          select.createEl('option', { value: priority.id, text: priority.label })
        }
        select.value = this.draft.priority ?? ''
        select.addEventListener('change', () => {
          this.draft.priority = select.value || undefined
        })
        return wrap
      },
      'chevrons-up'
    )

    // -- type --------------------------------------------------------------
    renderPropRow(
      grid,
      'Tipo',
      () => {
        const wrap = createDiv('pn-prop-value')
        const select = wrap.createEl('select', { cls: 'dropdown' })
        select.createEl('option', { value: 'task', text: 'Tarea' })
        select.createEl('option', { value: 'milestone', text: 'Hito' })
        select.value = this.draft.milestone ? 'milestone' : 'task'
        select.addEventListener('change', () => {
          // A milestone is a point in time: it keeps `due` and drops the start date.
          this.draft.milestone = select.value === 'milestone'
          if (this.draft.milestone) this.draft.scheduled = undefined
          this.render()
        })
        return wrap
      },
      'diamond'
    )

    // -- dates -------------------------------------------------------------
    if (!this.draft.milestone) {
      this.dateRow(grid, 'Inicio', 'scheduled', 'play')
    }
    this.dateRow(grid, 'Vencimiento', 'due', 'calendar')

    // -- progress ----------------------------------------------------------
    renderPropRow(
      grid,
      'Progreso',
      () => {
        const wrap = createDiv('pn-prop-value pn-prop-value--progress')
        const bar = new ProgressBar(wrap)
        const slider = wrap.createEl('input', {
          attr: { type: 'range', min: '0', max: '100', step: '5' }
        })
        slider.value = String(this.draft.progress ?? 0)
        bar.setValue(this.draft.progress ?? 0)
        slider.addEventListener('input', () => {
          this.draft.progress = Number(slider.value)
          bar.setValue(this.draft.progress)
        })
        return wrap
      },
      'percent'
    )

    // -- time estimate: stored in minutes, typed in hours -------------------
    renderPropRow(
      grid,
      'Estimación (h)',
      () => {
        const wrap = createDiv('pn-prop-value')
        const input = wrap.createEl('input', {
          attr: { type: 'number', min: '0', step: '0.25', placeholder: '0' }
        })
        input.value =
          this.draft.timeEstimate === undefined
            ? ''
            : String(round2(this.draft.timeEstimate / 60))
        input.addEventListener('change', () => {
          const hours = Number(input.value)
          this.draft.timeEstimate =
            input.value.trim() === '' || !Number.isFinite(hours)
              ? undefined
              : Math.round(hours * 60)
        })
        return wrap
      },
      'clock'
    )

    // -- assignees ---------------------------------------------------------
    renderPropRow(
      grid,
      'Asignados',
      () => {
        const wrap = createDiv('pn-prop-value')
        if (this.draft.assignees.length) {
          new AvatarStack(wrap).setNames(this.draft.assignees)
        }
        const input = wrap.createEl('input', {
          attr: { type: 'text', placeholder: 'Nombres separados por comas' }
        })
        input.value = this.draft.assignees.join(', ')
        input.addEventListener('change', () => {
          this.draft.assignees = splitList(input.value)
        })
        return wrap
      },
      'users'
    )

    // -- tags --------------------------------------------------------------
    renderPropRow(
      grid,
      'Etiquetas',
      () => {
        const wrap = createDiv('pn-prop-value')
        for (const tag of this.draft.tags) {
          new Chip(wrap).setLabel(tag).setVariant('plain').el.addClass('pn-chip--tag')
        }
        const input = wrap.createEl('input', {
          attr: { type: 'text', placeholder: 'etiqueta, etiqueta' }
        })
        input.value = this.draft.tags.join(', ')
        input.addEventListener('change', () => {
          this.draft.tags = splitList(input.value)
          this.render()
        })
        return wrap
      },
      'tag'
    )

    // -- projects ----------------------------------------------------------
    renderPropRow(
      grid,
      'Proyecto',
      () => {
        const wrap = createDiv('pn-prop-value')
        for (const ref of this.draft.projects) {
          new Chip(wrap).setLabel(linkLabel(ref)).setVariant('outline')
        }
        const input = wrap.createEl('input', {
          attr: { type: 'text', placeholder: '[[Proyecto]]' }
        })
        input.value = this.draft.projects.join(', ')
        input.addEventListener('change', () => {
          this.draft.projects = splitList(input.value)
          this.render()
        })
        return wrap
      },
      'folder'
    )

    // -- dependencies ------------------------------------------------------
    if (this.draft.blockedBy.length) {
      renderPropRow(
        grid,
        'Bloqueada por',
        () => {
          const wrap = createDiv('pn-prop-value')
          for (const dep of this.draft.blockedBy) {
            const resolved = this.plugin.tasks.resolve(dep.uid, this.draft.path)
            const chip = new Chip(wrap)
              .setLabel(resolved?.title ?? linkLabel(dep.uid))
              .setVariant(resolved ? 'outline' : 'plain')
            if (!resolved) chip.el.addClass('pn-chip--unresolved')
          }
          return wrap
        },
        'link'
      )
    }

    // -- project-declared fields -------------------------------------------
    for (const field of config.fields) {
      this.customFieldRow(grid, field)
    }

    // -- attachments -------------------------------------------------------
    renderPropRow(
      grid,
      'Adjuntos',
      () => {
        const wrap = createDiv('pn-prop-value')
        for (const ref of this.draft.attachments) {
          const chip = new Chip(wrap).setLabel(linkLabel(ref)).setVariant('outline')
          setIcon(chip.el.createSpan({ cls: 'pn-chip-icon' }), 'paperclip')
        }
        const input = wrap.createEl('input', {
          attr: { type: 'text', placeholder: '[[archivo.pdf]]' }
        })
        input.value = this.draft.attachments.join(', ')
        input.addEventListener('change', () => {
          this.draft.attachments = splitList(input.value)
          this.render()
        })
        return wrap
      },
      'paperclip'
    )

    // -- actions -----------------------------------------------------------
    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText('Abrir nota').onClick(() => {
          const file = this.app.vault.getAbstractFileByPath(this.draft.path)
          if (file) void this.app.workspace.getLeaf(false).openFile(file as never)
          this.close()
        })
      )
      .addButton((button) =>
        button
          .setButtonText('Guardar')
          .setCta()
          .onClick(() => void this.commit())
      )
  }

  private dateRow(
    grid: HTMLElement,
    label: string,
    key: 'scheduled' | 'due',
    icon: string
  ): void {
    renderPropRow(
      grid,
      label,
      () => {
        const wrap = createDiv('pn-prop-value')
        const input = wrap.createEl('input', { attr: { type: 'date' } })
        input.value = (this.draft[key] ?? '').slice(0, 10)
        input.addEventListener('change', () => {
          this.draft[key] = input.value || undefined
        })
        return wrap
      },
      icon
    )
  }

  private customFieldRow(grid: HTMLElement, field: CustomFieldDef): void {
    renderPropRow(
      grid,
      field.label,
      () => {
        const wrap = createDiv('pn-prop-value')
        const current = this.draft.customFields[field.key]

        if (field.type === 'checkbox') {
          const input = wrap.createEl('input', { attr: { type: 'checkbox' } })
          input.checked = current === true
          input.addEventListener('change', () => {
            this.draft.customFields[field.key] = input.checked
          })
          return wrap
        }

        if (field.type === 'select' || field.type === 'multiselect') {
          const select = wrap.createEl('select', { cls: 'dropdown' })
          if (field.type === 'multiselect') select.multiple = true
          else select.createEl('option', { value: '', text: '—' })
          for (const option of field.options ?? []) {
            select.createEl('option', { value: option, text: option })
          }
          const selected = Array.isArray(current) ? current.map(String) : [String(current ?? '')]
          for (const option of Array.from(select.options)) {
            option.selected = selected.includes(option.value)
          }
          select.addEventListener('change', () => {
            this.draft.customFields[field.key] =
              field.type === 'multiselect'
                ? Array.from(select.selectedOptions).map((o) => o.value)
                : select.value || undefined
          })
          return wrap
        }

        const type = field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'
        const input = wrap.createEl('input', { attr: { type } })
        input.value = current === undefined || current === null ? '' : String(current)
        input.addEventListener('change', () => {
          if (input.value.trim() === '') {
            delete this.draft.customFields[field.key]
          } else {
            this.draft.customFields[field.key] =
              field.type === 'number' ? Number(input.value) : input.value
          }
        })
        return wrap
      },
      field.icon
    )
  }

  /** §2.2.1: a completed non-recurring task must carry `completedDate`. */
  private stampCompletion(statuses: { id: string; complete: boolean }[]): void {
    const complete = isCompleteStatus(statuses as never, this.draft.status)
    if (complete && !this.draft.recurrence && !this.draft.completedDate) {
      this.draft.completedDate = new Date().toISOString().slice(0, 10)
    }
    if (!complete) this.draft.completedDate = undefined
  }

  private primaryProjectPath(): string | undefined {
    for (const ref of this.task.projects) {
      const file = this.app.metadataCache.getFirstLinkpathDest(
        ref.replace(/^\[\[|\]\]$/g, ''),
        this.task.path
      )
      if (file && this.plugin.projects.get(file.path)) return file.path
    }
    return undefined
  }

  private async commit(): Promise<void> {
    const config = this.plugin.projects.resolve(this.primaryProjectPath())
    await this.plugin.tasks.update(
      this.task.path,
      this.draft,
      config.fields.map((f) => f.key)
    )
    this.close()
  }
}

function splitList(raw: string): string[] {
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}
