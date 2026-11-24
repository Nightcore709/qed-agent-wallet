/**
 * In-memory, process-lifetime idempotency for shared disposable-sandbox operations.
 * A browser may lose the POST response after the server has already accepted a
 * financial action. The request identifier is bound to the client connection and
 * exact operation payload so a second POST cannot create a second chain job.
 *
 * This is NOT permanent transaction storage. On server restart the sandbox also
 * restarts. An unknown result must be reported as uncertain, never retried silently.
 */
import { createHash } from 'node:crypto';

export class SubmissionTracker {
  #records = new Map();

  check(client, key, operation, payload) {
    if (key === undefined) return { kind: 'unkeyed' }; // backwards-compatible scripted clients
    if (typeof key !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(key)) {
      return { kind: 'invalid' };
    }
    const mapKey = `${client}\0${key.toLowerCase()}`;
    const fingerprint = createHash('sha256').update(JSON.stringify([operation, payload])).digest('hex');
    const previous = this.#records.get(mapKey);
    if (previous) return previous.fingerprint === fingerprint
      ? { kind: 'existing', jobId: previous.jobId }
      : { kind: 'conflict' };
    return { kind: 'new', mapKey, fingerprint };
  }

  register(checked, jobId) {
    if (checked.kind !== 'new') return;
    this.#records.set(checked.mapKey, { fingerprint: checked.fingerprint, jobId });
  }

  lookup(client, key) {
    if (typeof key !== 'string') return undefined;
    return this.#records.get(`${client}\0${key.toLowerCase()}`)?.jobId;
  }
}
