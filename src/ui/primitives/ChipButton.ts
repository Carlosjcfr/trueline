/*
 * Adapted from Project Manager for Obsidian.
 * Copyright (c) 2026 Stepan Kropachev. MIT — see licenses/obsidian-pm.LICENSE
 * Changes: `pm-` CSS prefix renamed to `tl-`, utils import repointed.
 */
import { ButtonComponent } from 'obsidian'

export class ChipButton {
  el: HTMLButtonElement
  private button: ButtonComponent

  constructor(parentEl: HTMLElement) {
    this.button = new ButtonComponent(parentEl)
    this.el = this.button.buttonEl
    this.el.addClass('tl-chip-btn')
  }

  setLabel(text: string): this {
    this.button.setButtonText(text)
    return this
  }

  setActive(active: boolean): this {
    this.el.toggleClass('tl-chip-btn--active', active)
    return this
  }

  setShape(shape: 'rounded' | 'pill'): this {
    this.el.toggleClass('tl-chip-btn--pill', shape === 'pill')
    return this
  }

  setAriaLabel(label: string): this {
    this.el.setAttribute('aria-label', label)
    return this
  }

  onClick(handler: (e: MouseEvent) => unknown): this {
    this.button.onClick(handler)
    return this
  }

  onContextMenu(handler: (e: MouseEvent) => unknown): this {
    this.el.addEventListener('contextmenu', handler)
    return this
  }
}
