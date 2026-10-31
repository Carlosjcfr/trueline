/*
 * Adapted from Project Manager for Obsidian.
 * Copyright (c) 2026 Stepan Kropachev. MIT — see licenses/obsidian-pm.LICENSE
 */
import { setIcon } from 'obsidian'

/** One label/value line of the property grid. */
export function renderPropRow(
  container: HTMLElement,
  label: string,
  valueBuilder: () => HTMLElement,
  icon?: string
): HTMLElement {
  const row = container.createDiv('tl-prop-row')
  const labelEl = row.createSpan({ cls: 'tl-prop-label' })
  if (icon) {
    labelEl.addClass('tl-prop-label--with-icon')
    setIcon(labelEl.createSpan({ cls: 'tl-prop-label-icon' }), icon)
    labelEl.createSpan({ text: label })
  } else {
    labelEl.setText(label)
  }
  row.appendChild(valueBuilder())
  return row
}
