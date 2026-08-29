/*
 * Small DOM helpers shared by the UI layer.
 * `displayName`, `stringToColor` and `makeActivatable` are adapted from Project
 * Manager for Obsidian — Copyright (c) 2026 Stepan Kropachev, MIT.
 * See licenses/obsidian-pm.LICENSE
 */

import { parseLinktext, setIcon } from 'obsidian'

/** Human label for a frontmatter value that may be a wikilink, a path or plain text. */
export function displayName(raw: string): string {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  const match = /^\[\[([^\]]+)\]\]$/.exec(trimmed)
  if (!match) return trimmed
  const inner = match[1] ?? ''
  const pipe = inner.indexOf('|')
  if (pipe >= 0) {
    const alias = inner.slice(pipe + 1).trim()
    if (alias) return alias
  }
  const target = pipe >= 0 ? inner.slice(0, pipe) : inner
  const { path } = parseLinktext(target)
  const base = path.split('/').pop() ?? path
  return (base.endsWith('.md') ? base.slice(0, -3) : base).trim()
}

/** Deterministic colour for a name, so the same person keeps the same avatar tint. */
export function stringToColor(value: string): string {
  let hash = 0
  for (let i = 0; i < value.length; i++) {
    hash = value.charCodeAt(i) + ((hash << 5) - hash)
  }
  return `hsl(${Math.abs(hash) % 360}, 55%, 45%)`
}

/** Makes a non-button element behave like a link for mouse and keyboard alike. */
export function makeActivatable(el: HTMLElement, open: () => void): void {
  el.setAttr('role', 'link')
  el.setAttr('tabindex', '0')
  el.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    open()
  })
  el.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    event.stopPropagation()
    open()
  })
}

const iconNameCache = new Map<string, boolean>()

/** True for a Lucide id such as `flame`, false for an emoji or plain text. */
export function isIconName(icon: string): boolean {
  let known = iconNameCache.get(icon)
  if (known === undefined) {
    const probe = createSpan()
    setIcon(probe, icon)
    known = probe.firstElementChild !== null
    iconNameCache.set(icon, known)
  }
  return known
}

/** Renders either a Lucide icon or an emoji into `el`, whichever the value is. */
export function renderIcon(el: HTMLElement, icon: string): void {
  if (!icon) return
  if (isIconName(icon)) setIcon(el, icon)
  else el.setText(icon)
}
