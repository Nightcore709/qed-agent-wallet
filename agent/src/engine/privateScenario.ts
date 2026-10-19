import { keccak256, toHex, type Hex } from "viem";
import { covarianceFrom } from "./riskModel.js";
import { covToFixed } from "./privateMinvar.js";

/**
 * "Helix Private Markets Model — Oct 2026": an ILLUSTRATIVE covariance model for six private-market
 * sleeves, licensed by the vendor agent to QED and never published. Figures are synthetic and are not
 * investment advice or real market data. In the private job only its Poseidon commitment goes on-chain.
 */
export const PRIVATE_ASSETS = [
  "Private Credit",
  "Core Infrastructure",
  "EM Sovereign Debt",
  "Farmland",
  "Venture Capital",
  "Catastrophe Bonds",
] as const;

export const PRIVATE_VOLS = [0.08, 0.1, 0.12, 0.09, 0.3, 0.05];

export const PRIVATE_CORR: number[][] = [
  [1.0, 0.45, 0.4, 0.15, 0.35, 0.05],
  [0.45, 1.0, 0.3, 0.25, 0.3, 0.05],
  [0.4, 0.3, 1.0, 0.1, 0.3, 0.02],
  [0.15, 0.25, 0.1, 1.0, 0.1, 0.0],
  [0.35, 0.3, 0.3, 0.1, 1.0, 0.05],
  [0.05, 0.05, 0.02, 0.0, 0.05, 1.0],
];

export const PRIVATE_UNIVERSE: Hex = keccak256(toHex("helix-private-markets/2026-10/" + PRIVATE_ASSETS.join("|")));

export const privateCovariance = (): bigint[] => covToFixed(covarianceFrom(PRIVATE_VOLS, PRIVATE_CORR));
