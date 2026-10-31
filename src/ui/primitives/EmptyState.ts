/*
 * Adapted from Project Manager for Obsidian.
 * Copyright (c) 2026 Stepan Kropachev. MIT — see licenses/obsidian-pm.LICENSE
 * Changes: `pm-` CSS prefix renamed to `tl-`, utils import repointed.
 */
import { ButtonComponent } from 'obsidian'

export class EmptyState {
  el: HTMLElement
  private iconEl?: HTMLElement
  private titleEl?: HTMLElement
  private bodyEl?: HTMLElement
  private actionEl?: HTMLElement

  constructor(parentEl: HTMLElement) {
    this.el = parentEl.createDiv('tl-empty-state')
  }

  setIcon(text: string): this {
    this.iconEl ??= this.el.createDiv('tl-empty-icon')
    this.iconEl.setText(text)
    return this
  }

  setTitle(text: string): this {
    this.titleEl ??= this.el.createEl('h3')
    this.titleEl.setText(text)
    return this
  }

  setBody(text: string): this {
    this.bodyEl ??= this.el.createEl('p')
    this.bodyEl.setText(text)
    return this
  }

  setAction(label: string, onClick: () => void): this {
    if (!this.actionEl) this.actionEl = this.el.createDiv('tl-empty-action')
    this.actionEl.empty()
    new ButtonComponent(this.actionEl).setButtonText(label).setCta().onClick(onClick)
    return this
  }
}
