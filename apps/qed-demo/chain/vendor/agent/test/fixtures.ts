import type { ChatContext } from "../src/brain/types.js";

const U = (x: number) => BigInt(Math.round(x * 1e6));

/** The vault state right after job #1 settles (matches the live run). */
export const ctx: ChatContext = {
  balance: U(109),
  protectedBalance: U(70),
  free: U(39),
  blastRadius24h: U(39),
  dailyCap: U(25),
  spentInWindow: U(6),
  paused: false,
  payees: [
    { label: "Helix Data", aliases: ["helix", "vendor", "data vendor", "data"], address: "0x68b9bf7e480d364Cb0b97EDD85C8ab6D075aE1Af", approved: true },
    { label: "CloudCo", aliases: ["cloudco", "cloud", "compute"], address: "0xc71692d189C884cA9c4faC3c127001f27373256b", approved: true },
  ],
};
