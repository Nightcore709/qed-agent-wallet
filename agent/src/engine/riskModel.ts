import { encodeAbiParameters, keccak256, toHex, type Hex } from "viem";
import { covToWad, type MinVarSpec, type MinVarSolution } from "./minvar.js";

/**
 * "Helix Risk Model — Oct 2026" — an ILLUSTRATIVE multi-asset covariance model sold by the demo
 * data-vendor agent. Volatilities and correlations are plausible long-run figures chosen for the
 * demonstration; they are synthetic and are NOT investment advice or real market data.
 */
export const HELIX_ASSETS = [
  "Global Equities",
  "US Treasuries 7-10y",
  "Gold",
  "Bitcoin",
  "IG Corporate Credit",
  "Global REITs",
] as const;

export const HELIX_VOLS = [0.16, 0.06, 0.15, 0.6, 0.07, 0.2];

export const HELIX_CORR: number[][] = [
  [1.0, -0.2, 0.05, 0.35, 0.45, 0.75],
  [-0.2, 1.0, 0.25, -0.05, 0.6, 0.1],
  [0.05, 0.25, 1.0, 0.15, 0.2, 0.1],
  [0.35, -0.05, 0.15, 1.0, 0.15, 0.3],
  [0.45, 0.6, 0.2, 0.15, 1.0, 0.45],
  [0.75, 0.1, 0.1, 0.3, 0.45, 1.0],
];

export function covarianceFrom(vols: number[], corr: number[][]): number[][] {
  return vols.map((vi, i) => vols.map((vj, j) => Number((vi * vj * corr[i][j]).toFixed(12))));
}

export const HELIX_UNIVERSE: Hex = keccak256(toHex("helix-risk-model/2026-10/" + HELIX_ASSETS.join("|")));

/** The problem specification a client posts: Helix covariance, tolerance τ = 1e-9. */
export function helixSpec(tol: bigint = 10n ** 9n): MinVarSpec {
  const S = covarianceFrom(HELIX_VOLS, HELIX_CORR);
  return { n: S.length, cov: covToWad(S), tol, universe: HELIX_UNIVERSE };
}

// ─────────────────────────────── ABI codecs (must match MinVarianceVerifier) ───────────────────────────────

export function encodeSpec(spec: MinVarSpec): Hex {
  return encodeAbiParameters(
    [{ type: "uint256" }, { type: "int256[]" }, { type: "uint256" }, { type: "bytes32" }],
    [BigInt(spec.n), spec.cov, spec.tol, spec.universe],
  );
}

export function encodeSolution(sol: MinVarSolution): Hex {
  return encodeAbiParameters(
    [{ type: "int256[]" }, { type: "int256" }, { type: "int256[]" }, { type: "int256[]" }],
    [sol.w, sol.nu, sol.mu, sol.L],
  );
}

export const specHash = (spec: MinVarSpec): Hex => keccak256(encodeSpec(spec));
