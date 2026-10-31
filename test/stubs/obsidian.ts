/**
 * Stub for the `obsidian` module.
 *
 * The real package ships types only — there is no runtime entry, because the API is
 * injected by the app at load time. Unit tests that import a module which touches
 * `obsidian` need something importable; anything a test actually exercises should be
 * pure logic that never calls into these.
 */

export class Notice {
  constructor(public message: string) {}
}

export class Plugin {}
export class Modal {}
export class ItemView {}
export class PluginSettingTab {}
export class Setting {}
export class TFile {}

export function setIcon(): void {}
export function normalizePath(path: string): string {
  return path
}
export function parseLinktext(text: string): { path: string; subpath: string } {
  return { path: text, subpath: '' }
}
export function requestUrl(): never {
  throw new Error('requestUrl is not available in tests; stub the client instead.')
}

/** Real enough for code under test: runs `fn` on the trailing edge after `wait` ms. */
export function debounce<T extends unknown[]>(fn: (...args: T) => void, wait = 0) {
  let handle: ReturnType<typeof setTimeout> | undefined
  const wrapped = (...args: T): void => {
    if (handle) clearTimeout(handle)
    handle = setTimeout(() => fn(...args), wait)
  }
  return Object.assign(wrapped, {
    cancel: () => handle && clearTimeout(handle),
    run: () => undefined
  })
}
