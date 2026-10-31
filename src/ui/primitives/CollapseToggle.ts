/*
 * Adapted from Project Manager for Obsidian.
 * Copyright (c) 2026 Stepan Kropachev. MIT — see licenses/obsidian-pm.LICENSE
 * Changes: `pm-` CSS prefix renamed to `tl-`, utils import repointed.
 */
import { setIcon } from 'obsidian'

export interface CollapseToggleProps {
  collapsed: boolean
  onToggle: (e: MouseEvent) => unknown
  /** What is being collapsed, for the aria label. Defaults to subtasks. */
  subject?: string
}

export class CollapseToggle {
  el: HTMLElement

  constructor(parentEl: HTMLElement, props: CollapseToggleProps) {
    this.el = parentEl.createDiv({ cls: 'tree-item-icon collapse-icon tl-collapse-toggle' })
    setIcon(this.el, 'right-triangle')
    this.el.toggleClass('is-collapsed', props.collapsed)
    const subject = props.subject ?? 'subtasks'
    this.el.setAttr('aria-label', `${props.collapsed ? 'Expand' : 'Collapse'} ${subject}`)
    this.el.addEventListener('click', props.onToggle)
  }
}
