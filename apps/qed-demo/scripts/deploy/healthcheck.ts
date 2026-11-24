/**
 * The container's own health check (Dockerfile HEALTHCHECK; docs/DEPLOY.md, "Runtime hardening"): one request to the API's
 * liveness probe on loopback, exit 0 on a 2xx, 1 otherwise. No shell, no curl: the image has neither need.
 *
 * It asks /api/live (the process answers), not /api/ready: a container runtime that restarts on "not ready" would restart
 * the service during every migration or engine start. Readiness is for Railway's deploy check and the outside monitor.
 * The Host header is one the API accepts under a public origin: QED_EXTRA_HOSTS' first name (Railway's health host) else
 * QED_PUBLIC_ORIGIN's host. Railway's docs describe only its own check (at deploy) and do not mention a Dockerfile HEALTHCHECK;
 * Docker and Compose hosts use this one.
 */
import { request } from 'node:http'

export function probeTarget(env: Record<string, string | undefined>): { port: number; host?: string; path: string } {
  const port = Number(env.QED_API_PORT ?? env.PORT ?? 8080)
  let host = (env.QED_EXTRA_HOSTS ?? '').split(',').map((h) => h.trim()).find(Boolean)
  if (!host && env.QED_PUBLIC_ORIGIN) { try { host = new URL(env.QED_PUBLIC_ORIGIN).host } catch { /* the supervisor refuses a bad origin */ } }
  return { port, host, path: '/api/live' }
}

export function probe(env: Record<string, string | undefined>, timeoutMs = 4000): Promise<number> {
  const t = probeTarget(env)
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port: t.port, path: t.path, method: 'GET', headers: t.host ? { host: t.host } : {}, timeout: timeoutMs }, (res) => { res.resume(); resolve(res.statusCode ?? 0) })
    req.on('timeout', () => { req.destroy(); resolve(0) })
    req.on('error', () => resolve(0))
    req.end()
  })
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const status = await probe(process.env)
  process.exit(status >= 200 && status < 300 ? 0 : 1)
}
