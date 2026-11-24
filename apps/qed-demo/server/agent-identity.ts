/**
 * An agent identity on every request to an institution (N-021). QED is software acting for a person and says so: it never
 * presents as the person and never uses a person's browser session, password or one-time code. Every call QED makes to a
 * simulated institution goes through withAgentIdentity(), which attaches QED's registered agent identity to the request,
 * refuses to send a request without it, and records the request (institution, operation, identity, time) so that a test can
 * assert the identity on every outbound request.
 *
 * SIMULATED: the identity here is QED's own, registered with its own stand-ins (registration: 'simulation'). A real institution
 * that requires one (an OAuth client, or signed HTTP requests as in the IETF Web Bot Auth draft, whose signature conveys no
 * authority by itself) is EXT-14. The signature mechanism is not built; the identity is a declared client id and kind.
 */
import { refused } from './core.ts'

export interface AgentIdentity { clientId: string; software: 'QED'; kind: 'software-agent'; presentsAsPerson: false; registration: 'simulation'; actingFor: string }
export const QED_CLIENT_ID = 'qed-paper-agent/1'
export const identityFor = (workspaceId: string): AgentIdentity => ({ clientId: QED_CLIENT_ID, software: 'QED', kind: 'software-agent', presentsAsPerson: false, registration: 'simulation', actingFor: workspaceId })

export interface OutboundRequest { institution: string; operation: string; at: number; identity: AgentIdentity | null; via: 'agent-api' }
const LOG_MAX = 500
const log: OutboundRequest[] = []
export const outboundRequests = (): readonly OutboundRequest[] => log
export const clearOutboundRequests = (): void => { log.length = 0 }

/** What a simulated institution does at its door: it refuses a request that does not identify its sender as an agent. */
export function institutionDoor(req: OutboundRequest): void {
  const id = req.identity
  if (!id || id.kind !== 'software-agent' || id.presentsAsPerson !== false || !id.clientId) throw refused('agent_identity_missing', `${req.institution} refuses a request that does not identify its sender as an agent. Nothing was sent.`)
}

/**
 * Wrap a venue (or any institution object) so that each method call is a request carrying QED's identity. Reading a property that is
 * not a function passes through untouched. The methods run on the wrapped object itself, so what the institution does inside is not
 * recorded again as a second request.
 */
export function withAgentIdentity<T extends object>(institution: string, target: T, now: () => number, workspaceOf: (args: unknown[]) => string = (a) => String((a[0] as { userId?: string } | undefined)?.userId ?? 'qed')): T {
  return new Proxy(target, {
    get(t, prop) {
      const v = Reflect.get(t, prop, t)
      if (typeof v !== 'function' || typeof prop !== 'string') return v
      return (...args: unknown[]) => {
        const req: OutboundRequest = { institution, operation: prop, at: now(), identity: identityFor(workspaceOf(args)), via: 'agent-api' }
        institutionDoor(req)
        log.push(req); if (log.length > LOG_MAX) log.shift()
        return (v as (...a: unknown[]) => unknown).apply(t, args)
      }
    },
  })
}
