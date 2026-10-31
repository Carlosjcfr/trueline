/**
 * Minimal GitHub REST client.
 *
 * Built on Obsidian's `requestUrl` rather than `fetch` or Octokit, for three reasons:
 * `requestUrl` is not subject to CORS, it works on mobile where Octokit's transport
 * does not, and it keeps roughly a megabyte of SDK out of the plugin bundle. The API
 * surface we need is four endpoints.
 *
 * Conditional requests keep idle polling cheap: a poll that finds nothing new sends the
 * previous ETag, GitHub answers 304 with no body, and a 304 does not count against the
 * rate limit. See `pollIssues` for the one case where sending it would be wrong.
 */

import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from 'obsidian'

/** The HTTP call itself, injectable so the client can be tested without a network. */
export type Transport = (request: RequestUrlParam) => Promise<RequestUrlResponse>

/** Page size GitHub allows at most. */
const PER_PAGE = 100

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
  /** Oldest first. Empty when GitHub answered 304. */
  issues: GitHubIssue[]
  notModified: boolean
  /**
   * True when more pages remained after `maxPages`. Nothing is lost: the caller
   * advances its mark to the last issue it applied and the next poll continues there.
   */
  truncated: boolean
  /**
   * Seconds until the rate limit resets, when we were throttled. `issues` still holds
   * every page read before the throttle, so they can be applied rather than refetched.
   */
  retryAfter?: number
}

interface CachedValidator {
  etag: string
  /** Whether the response it validates fit in a single page. */
  complete: boolean
}

export class GitHubClient {
  private readonly validators = new Map<string, CachedValidator>()

  constructor(
    private token: string,
    private readonly transport: Transport = requestUrl
  ) {}

  setToken(token: string): void {
    this.token = token
    // A different identity sees different issues; the cached validators are worthless.
    this.validators.clear()
  }

  /**
   * Issues updated at or after `since`, **oldest first**, across as many pages as there
   * are, up to `maxPages`. Pull requests are filtered out: the issues endpoint returns
   * them too, and importing them as tasks is never what "sync my issues" means.
   *
   * Two decisions here fix issues being lost silently:
   *
   *  - **Every page is read.** The previous version read one page of 100 and stopped,
   *    so the 101st issue changed since the last poll was simply never seen.
   *
   *  - **Oldest first.** The caller advances its mark to the last issue it applied.
   *    Reading newest first made that impossible to do safely: when a pass stopped
   *    early, the issues it had not reached were *older* than the mark, and no later
   *    poll would ever ask for them again. Oldest first, a pass that stops early just
   *    resumes where it stopped.
   *
   * Oldest first has one consequence for the ETag. A newly updated issue lands at the
   * end of the list, so when the list spans pages, page one can come back byte for
   * byte identical - and a 304 on it would hide the change. The validator is therefore
   * sent only when the response it came from fit in one page, where any new issue is
   * guaranteed to change that page.
   */
  async pollIssues(repo: string, since?: string, maxPages = 10): Promise<PollResult> {
    const query = new URLSearchParams({
      state: 'all',
      per_page: String(PER_PAGE),
      sort: 'updated',
      direction: 'asc'
    })
    if (since) query.set('since', since)

    const firstUrl = `${API}/repos/${repo}/issues?${query.toString()}`
    const cached = this.validators.get(firstUrl)
    const issues: GitHubIssue[] = []
    let url: string | null = firstUrl
    let page = 0

    while (url && page < maxPages) {
      const etag = page === 0 && cached?.complete ? cached.etag : undefined
      const response = await this.request('GET', url, undefined, etag)

      if (response.status === 304) {
        return { issues: [], notModified: true, truncated: false }
      }
      if (response.status === 403 || response.status === 429) {
        return { issues, notModified: false, truncated: true, retryAfter: retryDelay(response) }
      }
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`GitHub ${response.status} al leer ${repo}`)
      }

      const next = nextPage(header(response, 'link'))
      if (page === 0) {
        const validator = header(response, 'etag')
        if (validator) this.validators.set(firstUrl, { etag: validator, complete: !next })
      }

      for (const issue of response.json as GitHubIssue[]) {
        if (!issue.pull_request) issues.push(issue)
      }
      url = next
      page++
    }

    return { issues, notModified: false, truncated: url !== null }
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

    return this.transport({
      url,
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      // Without this a 304 or a 403 throws, and a 304 is the successful case here.
      throw: false
    })
  }
}

/**
 * The `rel="next"` URL from a Link header, or null on the last page. GitHub's format:
 * `<https://api.github.com/...&page=2>; rel="next", <...&page=5>; rel="last"`.
 */
export function nextPage(link: string | undefined): string | null {
  if (!link) return null
  for (const part of link.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part)
    if (match) return match[1] ?? null
  }
  return null
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
