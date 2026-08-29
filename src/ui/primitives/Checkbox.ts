/*
 * Adapted from Project Manager for Obsidian.
 * Copyright (c) 2026 Stepan Kropachev. MIT — see licenses/obsidian-pm.LICENSE
 * Changes: `pm-` CSS prefix renamed to `pn-`, utils import repointed.
 */
/** Obsidian's native checkbox, for anything stored as a plain boolean. */
export class Checkbox {
  el: HTMLInputElement

  constructor(parentEl: HTMLElement) {
    this.el = parentEl.createEl('input', { type: 'checkbox', cls: 'pn-checkbox' })
  }

  setChecked(checked: boolean): this {
    this.el.checked = checked
    return this
  }

  /** What the box stands for, since the label naming it is usually a sibling. */
  setAriaLabel(label: string): this {
    this.el.setAttribute('aria-label', label)
    return this
  }

  onChange(handler: (checked: boolean) => void): this {
    this.el.addEventListener('change', () => handler(this.el.checked))
    return this
  }
}
