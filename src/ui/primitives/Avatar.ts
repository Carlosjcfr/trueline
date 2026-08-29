/*
 * Adapted from Project Manager for Obsidian.
 * Copyright (c) 2026 Stepan Kropachev. MIT — see licenses/obsidian-pm.LICENSE
 * Changes: `pm-` CSS prefix renamed to `pn-`, utils import repointed.
 */
import { setTooltip } from 'obsidian'
import { displayName, makeActivatable, stringToColor } from '../dom'

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const raw =
    parts.length >= 2
      ? `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}`
      : name.slice(0, 2)
  return raw.toUpperCase()
}

export class Avatar {
  el: HTMLSpanElement

  constructor(parentEl: HTMLElement) {
    this.el = parentEl.createSpan({ cls: 'pn-avatar' })
  }

  setName(name: string): this {
    const display = displayName(name)
    this.el.setText(initialsFor(display))
    this.el.style.background = stringToColor(display)
    setTooltip(this.el, display)
    return this
  }

  setSize(size: 'md' | 'sm'): this {
    this.el.toggleClass('pn-avatar--sm', size === 'sm')
    return this
  }

  setUnresolved(unresolved: boolean): this {
    this.el.toggleClass('pn-avatar--unresolved', unresolved)
    return this
  }

  onClick(handler: () => void): this {
    this.el.addClass('pn-avatar--link')
    makeActivatable(this.el, handler)
    return this
  }
}
