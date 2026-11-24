import { AnthropicBrain } from "./anthropic.js";
import { OfflineBrain } from "./offline.js";
import type { Brain, ChatContext } from "./types.js";

/** Live LLM first; if the API is unavailable for a turn, degrade gracefully to the offline brain
 *  (and say so in the transcript). Safety never depends on which one answered. */
class ResilientBrain implements Brain {
  readonly engine: string;
  private offline = new OfflineBrain();
  constructor(private primary: Brain) {
    this.engine = primary.engine;
  }
  async interpret(message: string, ctx: ChatContext, channel: "owner" | "counterparty") {
    try {
      return await this.primary.interpret(message, ctx, channel);
    } catch (e) {
      const r = await this.offline.interpret(message, ctx, channel);
      r.transcript.engine = `offline-fallback (${(e as Error).message.slice(0, 80)})`;
      return r;
    }
  }
}

export function makeBrain(): Brain {
  const key = process.env.ANTHROPIC_API_KEY;
  if (key && process.env.QED_OFFLINE !== "1") return new ResilientBrain(new AnthropicBrain(key));
  return new OfflineBrain();
}

export * from "./types.js";
export { guard, scan } from "./guard.js";
