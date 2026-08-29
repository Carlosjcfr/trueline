import { describe, expect, it } from 'vitest'
import { decide } from '../src/github/sync'
import {
  DEFAULT_SYNC_CONFIG,
  formatIssueRef,
  issueToTaskPatch,
  parseIssueRef,
  syncedFingerprint,
  taskToIssuePatch
} from '../src/github/mapping'
import type { GitHubIssue } from '../src/github/client'
import type { Task } from '../src/types'

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'demo',
    path: 'Tareas/demo.md',
    title: 'Revisar dietas',
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
    ...overrides
  }
}

function issue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    number: 412,
    title: 'Revisar dietas',
    body: null,
    state: 'open',
    state_reason: null,
    html_url: 'https://github.com/org/repo/issues/412',
    updated_at: '2026-08-01T10:00:00Z',
    closed_at: null,
    labels: [],
    assignees: [],
    milestone: null,
    ...overrides
  }
}

const config = DEFAULT_SYNC_CONFIG

describe('parseIssueRef', () => {
  it('round-trips a reference', () => {
    const ref = parseIssueRef('org/repo#412')
    expect(ref).toEqual({ repo: 'org/repo', number: 412 })
    expect(formatIssueRef(ref!.repo, ref!.number)).toBe('org/repo#412')
  })

  it('rejects anything that is not owner/repo#number', () => {
    for (const bad of ['repo#1', 'org/repo', 'org/repo#', '', undefined]) {
      expect(parseIssueRef(bad)).toBeNull()
    }
  })
})

describe('syncedFingerprint', () => {
  it('ignores fields the bridge does not push', () => {
    const base = task()
    const noisy = task({
      progress: 80,
      timeEntries: [{ startTime: '2026-08-01T09:00:00Z' }],
      body: 'notas nuevas',
      scheduled: '2026-09-01'
    })
    expect(syncedFingerprint(noisy, config)).toBe(syncedFingerprint(base, config))
  })

  it('changes when a synced field changes', () => {
    const before = syncedFingerprint(task(), config)
    expect(syncedFingerprint(task({ title: 'Otro título' }), config)).not.toBe(before)
    expect(syncedFingerprint(task({ status: 'done' }), config)).not.toBe(before)
    expect(syncedFingerprint(task({ tags: ['urgente'] }), config)).not.toBe(before)
  })

  it('does not depend on tag or assignee order', () => {
    const a = syncedFingerprint(task({ tags: ['a', 'b'], assignees: ['x', 'y'] }), config)
    const b = syncedFingerprint(task({ tags: ['b', 'a'], assignees: ['y', 'x'] }), config)
    expect(a).toBe(b)
  })
})

describe('decide', () => {
  const baseline = {
    remoteUpdatedAt: '2026-08-01T10:00:00Z',
    baselineUpdatedAt: '2026-08-01T10:00:00Z',
    fingerprint: 'aaaa1111',
    baselineHash: 'aaaa1111',
    direction: 'both' as const,
    conflictPolicy: 'manual' as const
  }

  it('does nothing when neither side moved', () => {
    expect(decide(baseline)).toBe('none')
  })

  it('pulls when only GitHub moved', () => {
    expect(decide({ ...baseline, remoteUpdatedAt: '2026-08-02T10:00:00Z' })).toBe('pull')
  })

  it('pushes when only the vault moved', () => {
    expect(decide({ ...baseline, fingerprint: 'bbbb2222' })).toBe('push')
  })

  it('adopts the issue the first time a task is linked to one', () => {
    // No baseline at all means the user just wrote gh-issue by hand. Flagging that as a
    // conflict would put every freshly linked task in the conflict list.
    expect(decide({ ...baseline, baselineHash: undefined, baselineUpdatedAt: undefined }))
      .toBe('pull')
    expect(
      decide({
        ...baseline,
        baselineHash: undefined,
        baselineUpdatedAt: undefined,
        direction: 'push'
      })
    ).toBe('push')
  })

  it('still treats a missing hash alone as a local change', () => {
    expect(decide({ ...baseline, baselineHash: undefined })).toBe('push')
  })

  it('flags a genuine conflict instead of guessing', () => {
    expect(
      decide({
        ...baseline,
        remoteUpdatedAt: '2026-08-02T10:00:00Z',
        fingerprint: 'bbbb2222'
      })
    ).toBe('conflict')
  })

  it('resolves a conflict the configured way', () => {
    const conflict = {
      ...baseline,
      remoteUpdatedAt: '2026-08-02T10:00:00Z',
      fingerprint: 'bbbb2222'
    }
    expect(decide({ ...conflict, conflictPolicy: 'prefer-remote' })).toBe('pull')
    expect(decide({ ...conflict, conflictPolicy: 'prefer-local' })).toBe('push')
  })

  it('never writes against the configured direction', () => {
    const localOnly = { ...baseline, fingerprint: 'bbbb2222' }
    expect(decide({ ...localOnly, direction: 'pull' })).toBe('none')

    const remoteOnly = { ...baseline, remoteUpdatedAt: '2026-08-02T10:00:00Z' }
    expect(decide({ ...remoteOnly, direction: 'push' })).toBe('none')

    const conflict = { ...localOnly, remoteUpdatedAt: '2026-08-02T10:00:00Z' }
    expect(decide({ ...conflict, direction: 'pull', conflictPolicy: 'prefer-local' }))
      .toBe('none')
    expect(decide({ ...conflict, direction: 'push', conflictPolicy: 'prefer-remote' }))
      .toBe('none')
  })
})

describe('issueToTaskPatch', () => {
  it('closes the task and stamps the completion date', () => {
    const patch = issueToTaskPatch(
      issue({ state: 'closed', closed_at: '2026-08-05T12:00:00Z' }),
      config,
      task()
    )
    expect(patch.status).toBe('done')
    expect(patch.completedDate).toBe('2026-08-05')
  })

  it('leaves a local in-progress status alone while the issue stays open', () => {
    const patch = issueToTaskPatch(issue(), config, task({ status: 'in-progress' }))
    expect(patch.status).toBe('in-progress')
  })

  it('reopens a task whose issue came back', () => {
    const patch = issueToTaskPatch(issue(), config, task({ status: 'done' }))
    expect(patch.status).toBe('open')
    expect(patch.completedDate).toBeUndefined()
  })

  it('splits priority labels out of the tags', () => {
    const patch = issueToTaskPatch(
      issue({ labels: [{ name: 'priority:high' }, { name: 'backend' }] }),
      config,
      task()
    )
    expect(patch.priority).toBe('high')
    expect(patch.tags).toEqual(['backend'])
  })
})

describe('taskToIssuePatch', () => {
  it('maps a completed status to a closed issue', () => {
    expect(taskToIssuePatch(task({ status: 'done' }), config).state).toBe('closed')
    expect(taskToIssuePatch(task({ status: 'in-progress' }), config).state).toBe('open')
  })

  it('re-attaches the priority as a label', () => {
    const patch = taskToIssuePatch(task({ tags: ['backend'], priority: 'high' }), config)
    expect(patch.labels).toEqual(['backend', 'priority:high'])
  })

  it('round-trips labels through both directions unchanged', () => {
    const original = issue({ labels: [{ name: 'priority:high' }, { name: 'backend' }] })
    const patched = issueToTaskPatch(original, config, task())
    const back = taskToIssuePatch(task({ ...patched } as Partial<Task>), config)
    expect((back.labels as string[]).sort()).toEqual(['backend', 'priority:high'])
  })
})
