/*
 * Adapted from Project Manager for Obsidian.
 * Copyright (c) 2026 Stepan Kropachev. MIT — see licenses/obsidian-pm.LICENSE
 * Changes: `pm-` CSS prefix renamed to `pn-`, utils import repointed.
 */
import { ExtraButtonComponent } from 'obsidian'

export interface ViewSwitcherOption<T extends string> {
  id: T
  icon: string
  label: string
}

export interface ViewSwitcherProps<T extends string> {
  options: ViewSwitcherOption<T>[]
  active: T
  onChange: (id: T) => void
}

export class ViewSwitcher<T extends string> {
  el: HTMLElement

  constructor(parentEl: HTMLElement, props: ViewSwitcherProps<T>) {
    this.el = parentEl.createDiv('pn-view-switcher')
    for (const opt of props.options) {
      const btn = new ExtraButtonComponent(this.el).setIcon(opt.icon).setTooltip(opt.label)
      btn.extraSettingsEl.addClass('pn-view-btn')
      if (opt.id === props.active) btn.extraSettingsEl.addClass('pn-view-btn--active')
      btn.onClick(() => {
        this.el.querySelectorAll('.pn-view-btn').forEach((b) => b.removeClass('pn-view-btn--active'))
        btn.extraSettingsEl.addClass('pn-view-btn--active')
        props.onChange(opt.id)
      })
    }
  }
}
