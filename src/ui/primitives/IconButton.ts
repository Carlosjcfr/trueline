/*
 * Adapted from Project Manager for Obsidian.
 * Copyright (c) 2026 Stepan Kropachev. MIT — see licenses/obsidian-pm.LICENSE
 * Changes: `pm-` CSS prefix renamed to `tl-`, utils import repointed.
 */
import { ExtraButtonComponent } from 'obsidian'

export class IconButton {
  el: HTMLElement
  private button: ExtraButtonComponent

  constructor(parentEl: HTMLElement) {
    this.button = new ExtraButtonComponent(parentEl)
    this.el = this.button.extraSettingsEl
    this.el.addClass('tl-icon-btn')
  }

  setIcon(name: string): this {
    this.button.setIcon(name)
    return this
  }

  setTooltip(text: string): this {
    this.button.setTooltip(text)
    return this
  }

  setRevealOnHover(enabled: boolean): this {
    this.el.toggleClass('tl-icon-btn--hover-only', enabled)
    return this
  }

  onClick(handler: (e: MouseEvent) => unknown): this {
    this.el.addEventListener('click', handler)
    return this
  }
}
