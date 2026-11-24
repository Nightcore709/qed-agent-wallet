/**
 * Waiting for the server's answer to one request, for steps whose server work is slow on purpose. A password is checked
 * with scrypt (N 2^17, 128 MiB: server/auth.ts), about half a second alone and several seconds when this shared machine
 * runs at load 40 to 60; a check that counted that work against its own 10 seconds failed on 24 Nov (password-change,
 * "Your money" not shown 10 s after "Sign in with your password", the request still unanswered). The check that follows
 * now starts when the server has answered, with its usual time; the test's own limit still bounds the whole.
 */
import type { Page, Response } from '@playwright/test'

/** Does `act` and waits for the server's answer to the request it sends (method and path); returns that answer. */
export async function answered(page: Page, method: string, path: string, act: () => Promise<unknown>): Promise<Response> {
  const [response] = await Promise.all([page.waitForResponse((r) => r.request().method() === method && new URL(r.url()).pathname === path), act()])
  return response
}
