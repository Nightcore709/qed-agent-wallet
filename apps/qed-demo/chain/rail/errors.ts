/** The rail's refusal type and its public error text, shared by every module (kept apart to avoid import cycles). */
export class RailError extends Error {
  code: string;
  http: number;
  details: Record<string, unknown>;
  constructor(code: string, message: string, http = 400, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "RailError";
    this.code = code;
    this.http = http;
    this.details = details;
  }
}

/** First paragraph only, without the RPC address: keeps the revert reason, drops viem's request dump. */
export const publicError = (e: unknown) => String((e as Error)?.message ?? e).split(/\n\s*\n/)[0].replace(/https?:\/\/127\.0\.0\.1:\d+/g, "[local chain]").slice(0, 400);
