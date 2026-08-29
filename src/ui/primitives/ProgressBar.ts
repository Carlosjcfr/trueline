/*
 * Adapted from Project Manager for Obsidian.
 * Copyright (c) 2026 Stepan Kropachev. MIT — see licenses/obsidian-pm.LICENSE
 * Changes: `pm-` CSS prefix renamed to `pn-`, utils import repointed.
 */
export class ProgressBar {
  el: HTMLDivElement
  private fill: HTMLDivElement
  private labelEl: HTMLElement | null = null
  private value = 0

  constructor(parentEl: HTMLElement) {
    this.el = parentEl.createDiv('pn-progress')
    const track = this.el.createDiv('pn-progress-track')
    this.fill = track.createDiv('pn-progress-fill')
  }

  setValue(percent: number): this {
    this.value = Math.max(0, Math.min(100, percent))
    this.fill.style.width = `${this.value}%`
    if (this.labelEl) this.labelEl.setText(`${Math.round(this.value)}%`)
    return this
  }

  setColor(color: string): this {
    this.el.style.setProperty('--pn-progress-color', color)
    return this
  }

  setSize(size: 'sm' | 'md'): this {
    this.el.toggleClass('pn-progress--sm', size === 'sm')
    return this
  }

  setShowLabel(show: boolean): this {
    if (show && !this.labelEl) {
      this.labelEl = this.el.createSpan({ cls: 'pn-progress-label', text: `${Math.round(this.value)}%` })
    } else if (!show && this.labelEl) {
      this.labelEl.remove()
      this.labelEl = null
    }
    return this
  }
}
