import { describe, expect, it } from 'vitest'
import type { App, RequestUrlParam, RequestUrlResponse } from 'obsidian'
import { GitHubClient, nextPage, type GitHubIssue } from '../src/github/client'
import { GitHubSync, type SyncOptions } from '../src/github/sync'
import { DEFAULT_SYNC_CONFIG, syncedFingerprint } from '../src/github/mapping'
import { defaultSettings, type TruelineSettings } from '../src/settings'
import type { TaskStore } from '../src/store/TaskStore'
import type { Task } from '../src/types'

// ---------------------------------------------------------------------------
// fixtures

function issue(number: number, updatedAt: string, extra: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    number,
    title: `Issue ${number}`,
    body: null,
    state: 'open',
    state_reason: null,
    html_url: `https://github.com/org/repo/issues/${number}`,
    updated_at: updatedAt,
    closed_at: null,
    labels: [],
    assignees: [],
    milestone: null,
    ...extra
  }
}

function response(
  status: number,
  json: unknown,
  headers: Record<string, string> = {}
): RequestUrlResponse {
  return { status, json, headers, text: '', arrayBuffer: new ArrayBuffer(0) } as RequestUrlResponse
}

/** A scripted transport: hands out the queued responses and records every request. */
function transport(queue: RequestUrlResponse[]) {
  const requests: RequestUrlParam[] = []
  const send = async (request: RequestUrlParam): Promise<RequestUrlResponse> => {
    requests.push(request)
    const next = queue.shift()
    if (!next) throw new Error(`unexpected request: ${request.url}`)
    return next
  }
  return { send, requests }
}

const link = (page: number) =>
  `<https://api.github.com/repositories/1/issues?page=${page}>; rel="next", ` +
  `<https://api.github.com/repositories/1/issues?page=9>; rel="last"`

// ---------------------------------------------------------------------------

describe('nextPage', () => {
  it('reads the next URL out of a Link header', () => {
    expect(nextPage(link(2))).toBe('https://api.github.com/repositories/1/issues?page=2')
  })

  it('returns null on the last page and without a header', () => {
    expect(nextPage('<https://x?page=1>; rel="prev", <https://x?page=1>; rel="first"')).toBeNull()
    expect(nextPage(undefined)).toBeNull()
  })
})

describe('bug 3: reading every page', () => {
  it('follows the pagination instead of stopping at the first 100', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => issue(i + 1, '2026-08-01T00:00:00Z'))
    const page2 = Array.from({ length: 100 }, (_, i) => issue(i + 101, '2026-08-02T00:00:00Z'))
    const page3 = [issue(201, '2026-08-03T00:00:00Z')]
    const t = transport([
      response(200, page1, { link: link(2) }),
      response(200, page2, { link: link(3) }),
      response(200, page3)
    ])

    const result = await new GitHubClient('tok', t.send).pollIssues('org/repo')
    expect(result.issues).toHaveLength(201)
    expect(result.truncated).toBe(false)
    expect(t.requests).toHaveLength(3)
  })

  it('asks oldest first, so a pass that stops early can resume where it stopped', async () => {
    const t = transport([response(200, [])])
    await new GitHubClient('tok', t.send).pollIssues('org/repo', '2026-08-01T00:00:00Z')
    const url = new URL(t.requests[0]?.url as string)
    expect(url.searchParams.get('direction')).toBe('asc')
    expect(url.searchParams.get('sort')).toBe('updated')
    expect(url.searchParams.get('since')).toBe('2026-08-01T00:00:00Z')
  })

  it('leaves pull requests out', async () => {
    const t = transport([
      response(200, [issue(1, '2026-08-01T00:00:00Z'), issue(2, '2026-08-01T00:00:00Z', { pull_request: {} })])
    ])
    const result = await new GitHubClient('tok', t.send).pollIssues('org/repo')
    expect(result.issues.map((i) => i.number)).toEqual([1])
  })

  it('stops at maxPages and says so', async () => {
    const t = transport([
      response(200, [issue(1, '2026-08-01T00:00:00Z')], { link: link(2) }),
      response(200, [issue(2, '2026-08-02T00:00:00Z')], { link: link(3) })
    ])
    const result = await new GitHubClient('tok', t.send).pollIssues('org/repo', undefined, 2)
    expect(result.issues.map((i) => i.number)).toEqual([1, 2])
    expect(result.truncated).toBe(true)
  })

  it('keeps the pages it read when throttled halfway', async () => {
    const t = transport([
      response(200, [issue(1, '2026-08-01T00:00:00Z')], { link: link(2) }),
      response(403, {}, { 'retry-after': '120' })
    ])
    const result = await new GitHubClient('tok', t.send).pollIssues('org/repo')
    expect(result.issues.map((i) => i.number)).toEqual([1])
    expect(result.retryAfter).toBe(120)
  })
})

describe('bug 3: the ETag cannot hide a change', () => {
  it('uses the validator when the last answer fit in one page', async () => {
    const t = transport([
      response(200, [issue(1, '2026-08-01T00:00:00Z')], { etag: '"v1"' }),
      response(304, null)
    ])
    const client = new GitHubClient('tok', t.send)
    await client.pollIssues('org/repo')
    const second = await client.pollIssues('org/repo')

    expect(t.requests[1]?.headers?.['If-None-Match']).toBe('"v1"')
    expect(second.notModified).toBe(true)
  })

  it('does not use it when the last answer spanned pages', async () => {
    // Oldest first, a new update lands on the last page: page one comes back identical
    // and a 304 on it would report "nothing changed" while something did.
    const t = transport([
      response(200, [issue(1, '2026-08-01T00:00:00Z')], { etag: '"v1"', link: link(2) }),
      response(200, [issue(2, '2026-08-02T00:00:00Z')]),
      response(200, [issue(1, '2026-08-01T00:00:00Z')], { link: link(2) }),
      response(200, [issue(2, '2026-08-02T00:00:00Z'), issue(3, '2026-08-03T00:00:00Z')])
    ])
    const client = new GitHubClient('tok', t.send)
    await client.pollIssues('org/repo')
    const second = await client.pollIssues('org/repo')

    expect(t.requests[2]?.headers?.['If-None-Match']).toBeUndefined()
    expect(second.issues.map((i) => i.number)).toContain(3)
  })
})

// ---------------------------------------------------------------------------
// the sync pass: where the mark moves to

type PollArgs = { repo: string; since: string | undefined }

function fakeClient(pages: GitHubIssue[][], extra: { truncated?: boolean } = {}) {
  const polls: PollArgs[] = []
  const client = {
    pollIssues: async (repo: string, since?: string) => {
      polls.push({ repo, since })
      const issues = pages.shift() ?? []
      return { issues, notModified: false, truncated: extra.truncated ?? false }
    },
    updateIssue: async () => issue(0, '2026-01-01T00:00:00Z'),
    setToken: () => {},
    whoami: async () => 'me'
  }
  return { client: client as unknown as GitHubClient, polls }
}

/** A task already linked and in agreement with `issue`, unless `stale`. */
function linkedTask(of: GitHubIssue, stale = false): Task {
  const base: Task = {
    id: `t${of.number}`,
    path: `Tareas/${of.number}.md`,
    title: of.title,
    status: 'open',
    dateCreated: '2026-01-01T00:00:00Z',
    dateModified: '2026-01-01T00:00:00Z',
    tags: [],
    contexts: [],
    projects: [],
    attachments: [],
    timeEntries: [],
    blockedBy: [],
    reminders: [],
    completeInstances: [],
    skippedInstances: [],
    assignees: [],
    customFields: {},
    unknown: {},
    archived: false,
    ghIssue: `org/repo#${of.number}`
  }
  base.ghUpdatedAt = stale ? '2025-01-01T00:00:00Z' : of.updated_at
  base.ghHash = syncedFingerprint(base, DEFAULT_SYNC_CONFIG)
  return base
}

function fakeTasks(tasks: Task[], failOn: Set<string> = new Set()) {
  const byPath = new Map(tasks.map((t) => [t.path, t]))
  return {
    all: () => [...byPath.values()],
    get: (path: string) => byPath.get(path),
    update: async (path: string, patch: Partial<Task>) => {
      if (failOn.has(path)) throw new Error('disco lleno')
      const current = byPath.get(path)
      if (current) byPath.set(path, { ...current, ...patch })
    }
  } as unknown as TaskStore
}

const OPTIONS: SyncOptions = {
  direction: 'both',
  conflictPolicy: 'manual',
  importNewIssues: false,
  exportNewTasks: false,
  repos: ['org/repo'],
  mapping: DEFAULT_SYNC_CONFIG
}

function makeSync(client: GitHubClient, tasks: TaskStore) {
  const settings: TruelineSettings = defaultSettings()
  let saves = 0
  const sync = new GitHubSync(
    {} as App,
    tasks,
    () => settings,
    async () => {
      saves++
    },
    client
  )
  return { sync, settings, saves: () => saves }
}

describe('bug 3: the mark only moves past what was applied', () => {
  const a = issue(1, '2026-08-01T00:00:00Z')
  const b = issue(2, '2026-08-02T00:00:00Z')
  const c = issue(3, '2026-08-03T00:00:00Z')

  it('advances to the last issue and persists it', async () => {
    const { client } = fakeClient([[a, b, c]])
    const { sync, settings, saves } = makeSync(client, fakeTasks([a, b, c].map((i) => linkedTask(i))))

    const report = await sync.run(OPTIONS)
    expect(report.errors).toEqual([])
    expect(settings.github.lastPolled['org/repo']).toBe(c.updated_at)
    expect(saves()).toBe(1)
  })

  it('stops at the first failure so the failed issue is retried', async () => {
    // Before, the mark jumped to the newest issue seen, failures included, and the
    // failed one was never asked for again.
    const tasks = [linkedTask(a), linkedTask(b, true), linkedTask(c)]
    const { client } = fakeClient([[a, b, c]])
    const { sync, settings } = makeSync(client, fakeTasks(tasks, new Set([tasks[1]!.path])))

    const report = await sync.run(OPTIONS)
    expect(report.errors).toHaveLength(1)
    expect(settings.github.lastPolled['org/repo']).toBe(a.updated_at)
  })

  it('asks for what came after the mark on the next pass', async () => {
    const { client, polls } = fakeClient([[a, b], []])
    const { sync } = makeSync(client, fakeTasks([a, b].map((i) => linkedTask(i))))

    await sync.run(OPTIONS)
    await sync.run(OPTIONS)
    expect(polls[0]?.since).toBeUndefined()
    expect(polls[1]?.since).toBe(b.updated_at)
  })

  it('resumes from a mark saved in an earlier session', async () => {
    const { client, polls } = fakeClient([[]])
    const { sync, settings } = makeSync(client, fakeTasks([]))
    settings.github.lastPolled['org/repo'] = '2026-07-15T00:00:00Z'

    await sync.run(OPTIONS)
    expect(polls[0]?.since).toBe('2026-07-15T00:00:00Z')
  })

  it('does not write the settings when nothing moved', async () => {
    const { client } = fakeClient([[]])
    const { sync, saves } = makeSync(client, fakeTasks([]))
    await sync.run(OPTIONS)
    expect(saves()).toBe(0)
  })

  it('reports a repo with more changes than one pass reads', async () => {
    const { client } = fakeClient([[a]], { truncated: true })
    const { sync } = makeSync(client, fakeTasks([linkedTask(a)]))
    const report = await sync.run(OPTIONS)
    expect(report.pending).toEqual(['org/repo'])
  })
})
