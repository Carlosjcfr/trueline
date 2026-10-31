/**
 * A minimal stand-in for the parts of Obsidian's App the stores touch.
 *
 * Deliberately not a mock of every method: only vault listing and creation, the
 * metadata cache, link resolution and `processFrontMatter`. Frontmatter is held as
 * parsed objects, and anything written as text (new notes) goes through a real YAML
 * parser, so a bug in our own YAML writer shows up here instead of being mirrored.
 *
 * Metadata events are NOT fired automatically. Obsidian fires them asynchronously after
 * a write, and the tests need to control exactly when that echo arrives.
 */

import { TFile } from 'obsidian'
import { parse as parseYaml } from 'yaml'

interface Entry {
  file: TFile
  frontmatter: Record<string, unknown>
  body: string
}

export class FakeVault {
  readonly entries = new Map<string, Entry>()
  readonly folders = new Set<string>()
  /** Called after `vault.create`, to stand in for the metadata event that follows. */
  onCreate: ((file: TFile) => void) | null = null

  readonly app = {
    vault: {
      getMarkdownFiles: (): TFile[] => [...this.entries.values()].map((e) => e.file),
      getAbstractFileByPath: (path: string): unknown =>
        this.entries.get(path)?.file ?? (this.folders.has(path) ? { path } : null),
      createFolder: async (path: string): Promise<void> => {
        this.folders.add(path)
      },
      create: async (path: string, contents: string): Promise<TFile> => {
        const match = /^---\n([\s\S]*?)\n?---\n?([\s\S]*)$/.exec(contents)
        const frontmatter = match ? ((parseYaml(match[1] ?? '') ?? {}) as Record<string, unknown>) : {}
        const file = this.add(path, frontmatter, match?.[2] ?? contents)
        this.onCreate?.(file)
        return file
      }
    },
    metadataCache: {
      getFileCache: (file: TFile) => this.cacheFor(file.path),
      getFirstLinkpathDest: (linkpath: string): TFile | null => {
        for (const entry of this.entries.values()) {
          const noExt = entry.file.path.replace(/\.md$/, '')
          if (noExt === linkpath || entry.file.basename === linkpath) return entry.file
        }
        return null
      }
    },
    fileManager: {
      processFrontMatter: async (
        file: TFile,
        fn: (frontmatter: Record<string, unknown>) => void
      ): Promise<void> => {
        const entry = this.entries.get(file.path)
        if (!entry) throw new Error(`no such file: ${file.path}`)
        fn(entry.frontmatter)
      }
    }
  }

  add(path: string, frontmatter: Record<string, unknown>, body = ''): TFile {
    const basename = (path.split('/').pop() ?? path).replace(/\.md$/, '')
    const file = Object.assign(new TFile(), { path, basename, extension: 'md' })
    this.entries.set(path, { file, frontmatter: structuredClone(frontmatter), body })
    return file
  }

  file(path: string): TFile {
    const entry = this.entries.get(path)
    if (!entry) throw new Error(`no such file: ${path}`)
    return entry.file
  }

  frontmatter(path: string): Record<string, unknown> {
    return this.entries.get(path)?.frontmatter ?? {}
  }

  /** Simulates an edit made outside the plugin: in the editor, by sync, by git. */
  edit(path: string, change: (frontmatter: Record<string, unknown>) => void, body?: string): void {
    const entry = this.entries.get(path)
    if (!entry) throw new Error(`no such file: ${path}`)
    change(entry.frontmatter)
    if (body !== undefined) entry.body = body
  }

  /** What Obsidian's metadata cache would hand over: a fresh parse, never the original. */
  cacheFor(path: string): { frontmatter: Record<string, unknown>; tags: [] } | null {
    const entry = this.entries.get(path)
    return entry ? { frontmatter: structuredClone(entry.frontmatter), tags: [] } : null
  }
}
