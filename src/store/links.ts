/**
 * Link parsing and resolution (spec §11).
 *
 * A reference to another note can arrive in three shapes, and all three occur in real
 * vaults: a wikilink `[[Note|alias]]`, a vault path, or a stable task id. Resolution
 * tries them in that order and falls back to an id lookup last, because ids are the
 * only form that survives a rename — which also makes them the least readable, so we
 * write wikilinks and keep ids for machinery (dependencies, the GitHub bridge).
 */

const WIKILINK = /^\s*!?\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|([^\]]*))?\]\]\s*$/

export interface ParsedLink {
  /** The link target as written, without alias, anchor or brackets. */
  target: string
  alias?: string
  isWikilink: boolean
}

export function parseLink(raw: string): ParsedLink {
  const match = WIKILINK.exec(raw)
  if (!match) return { target: raw.trim(), isWikilink: false }
  const target = (match[1] ?? '').trim()
  const alias = match[2]?.trim()
  return { target, isWikilink: true, ...(alias ? { alias } : {}) }
}

/** Wraps a path as a wikilink. Canonical writes use this form (§11.8). */
export function toWikilink(target: string): string {
  return `[[${stripExtension(target)}]]`
}

export function stripExtension(path: string): string {
  return path.endsWith('.md') ? path.slice(0, -3) : path
}

/** Display text for a reference, without touching the vault. */
export function linkLabel(raw: string): string {
  const { target, alias } = parseLink(raw)
  if (alias) return alias
  const base = target.split('/').pop() ?? target
  return stripExtension(base)
}
