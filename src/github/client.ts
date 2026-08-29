/**
 * Minimal GitHub REST client.
 *
 * Built on Obsidian's `requestUrl` rather than `fetch` or Octokit, for three reasons:
 * `requestUrl` is not subject to CORS, it works on mobile where Octokit's transport
 * does not, and it keeps roughly a megabyte of SDK out of the plugin bundle. The API
 * surface we need is four endpoints.
 *
 * Conditional requests are the point of this class. Every poll sends the ETag from the
 * previous one; GitHub answers 304 with no body, and a 304 does not count against the
 * rate limit. Polling a repo every minute all day therefore costs almost nothing.
 */

import { requestUrl, type RequestUrlResponse } from 'obsidian'

const API = 'https://api.github.com'

export interface GitHubIssue {
  number: number
  title: string
  body: string | null
  state: 'open' | 'closed'
  state_reason: string | null
  html_url: string
  updated_at: string
  closed_at: string | null
  labels: { name: string }[]
  assignees: { login: string }[]
  milestone: { title: string; due_on: string | null } | null
  pull_request?: unknown
}

export interface PollResult {
  /** Empty when GitHub answered 304 — nothing changed since the last poll. */
  issues: GitHubIssue[]
  etag?: string
  notModified: boolean
  /** Seconds until the rate limit resets, when we have been throttled. */
  retryAfter?: number
}

export class GitHubClient {
  private readonly etags = new Map<string, string>()

  constructor(private token: string) {}

  setToken(token: string): void {
    this.token = token
    // A different identity sees different issues; the cached validators are worthless.
    this.etags.clear()
  }

  /**
   * Issues updated since `since`, oldest first. Pull requests are filtered out: the
   * issues endpoint returns them too, and importing them as tasks is never what the
   * user meant by "sync my issues".
   */
  async pollIssues(repo: string, since?: string): Promise<PollResult> {
    const query = new URLSearchParams({
      state: 'all',
      per_page: '100',
      sort: 'updated',
      direction: 'desc'
    })
    if (since) query.set('since', since)

    const url = `${API}/repos/${repo}/issues?${query.toString()}`
    const response = await this.request('GET', url, undefined, this.etags.get(url))

    if (response.status === 304) return { issues: [], notModified: true }
    if (response.status === 403 || response.status === 429) {
      return { issues: [], notModified: false, retryAfter: retryDelay(response) }
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`GitHub ${response.status} al leer ${repo}`)
    }

    const etag = header(response, 'etag')
    if (etag) this.etags.set(url, etag)

    const issues = (response.json as GitHubIssue[]).filter((issue) => !issue.pull_request)
    return { issues, etag, notModified: false }
  }

  async getIssue(repo: string, number: number): Promise<GitHubIssue> {
    const response = await this.request('GET', `${API}/repos/${repo}/issues/${number}`)
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`GitHub ${response.status} al leer ${repo}#${number}`)
    }
    return response.json as GitHubIssue
  }

  async updateIssue(
    repo: string,
    number: number,
    patch: Record<string, unknown>
  ): Promise<GitHubIssue> {
    const response = await this.request(
      'PATCH',
      `${API}/repos/${repo}/issues/${number}`,
      patch
    )
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`GitHub ${response.status} al actualizar ${repo}#${number}`)
    }
    return response.json as GitHubIssue
  }

  async createIssue(repo: string, patch: Record<string, unknown>): Promise<GitHubIssue> {
    const response = await this.request('POST', `${API}/repos/${repo}/issues`, patch)
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`GitHub ${response.status} al crear un issue en ${repo}`)
    }
    return response.json as GitHubIssue
  }

  /** Verifies the token and returns the authenticated login. */
  async whoami(): Promise<string> {
    const response = await this.request('GET', `${API}/user`)
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Token rechazado (${response.status})`)
    }
    return (response.json as { login: string }).login
  }

  private async request(
    method: string,
    url: string,
    body?: unknown,
    etag?: string
  ): Promise<RequestUrlResponse> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    }
    if (this.token) headers.Authorization = `Bearer ${this.token}`
    if (etag) headers['If-None-Match'] = etag
    if (body !== undefined) headers['Content-Type'] = 'application/json'

    return requestUrl({
      url,
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      // Without this a 304 or a 403 throws, and a 304 is the successful case here.
      throw: false
    })
  }
}

function header(response: RequestUrlResponse, name: string): string | undefined {
  const headers = response.headers as Record<string, string> | undefined
  if (!headers) return undefined
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name)
  return key ? headers[key] : undefined
}

function retryDelay(response: RequestUrlResponse): number {
  const explicit = Number(header(response, 'retry-after'))
  if (Number.isFinite(explicit) && explicit > 0) return explicit
  const reset = Number(header(response, 'x-ratelimit-reset'))
  if (Number.isFinite(reset)) {
    return Math.max(60, Math.ceil(reset - Date.now() / 1000))
  }
  return 300
}
