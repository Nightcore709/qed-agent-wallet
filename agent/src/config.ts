import { existsSync, readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex, LocalAccount } from "viem";
import { Chain$ } from "./chain.js";

export type Role =
  | "DEPLOYER"
  | "OWNER"
  | "AGENT"
  | "COSIGNER"
  | "GUARDIAN"
  | "CLIENT"
  | "VENDOR"
  | "CREDITOR"
  | "ADVERSARY"
  | "HONEYPOT_AGENT"
  | "HONEYPOT_OWNER"
  | "HONEYPOT_COSIGNER";

/** Loads KEY=VALUE lines from a dotenv-style file into process.env (does not override). */
export function loadEnvFile(path: string) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

/** A process can only obtain the keys present in ITS environment. Child processes are spawned with
 *  exactly one key each (see scripts/live.ts), which is how key separation is enforced in practice. */
export function account(role: Role): LocalAccount {
  const pk = process.env[`${role}_PK`];
  if (!pk) throw new Error(`${role}_PK is not available to this process (key separation)`);
  return privateKeyToAccount(pk as Hex);
}

export function address(role: Role): Address {
  const a = process.env[`${role}_ADDR`];
  if (a) return a as Address;
  return account(role).address;
}

export function rpcConfig() {
  const rpcUrl = process.env.RPC_URL ?? "http://127.0.0.1:8545";
  const chainId = Number(process.env.CHAIN_ID ?? 31337);
  const fees =
    process.env.MAX_FEE_GWEI !== undefined
      ? {
          maxFeePerGas: BigInt(Math.round(Number(process.env.MAX_FEE_GWEI) * 1e9)),
          maxPriorityFeePerGas: BigInt(Math.round(Number(process.env.PRIORITY_FEE_GWEI ?? "0.1") * 1e9)),
        }
      : undefined;
  return { rpcUrl, chainId, fees };
}

export function chain(): Chain$ {
  const { rpcUrl, chainId, fees } = rpcConfig();
  return new Chain$(rpcUrl, chainId, fees);
}

export interface Deployment {
  chainId: number;
  network: string;
  explorer: string;
  token: Address;
  verifier: Address;
  escrow: Address;
  vault: Address;
  lens: Address;
  honeypotVault: Address;
  deployBlock: string;
  txs: Record<string, Hex>;
}

export const deploymentPath = (chainId: number) => `deployments/${chainId}.json`;

export function loadDeployment(chainId: number): Deployment {
  return JSON.parse(readFileSync(deploymentPath(chainId), "utf8"));
}

export const EXPLORERS: Record<number, string> = {
  11155111: "https://sepolia.etherscan.io",
  84532: "https://base-sepolia.blockscout.com",
  31337: "",
};

export const NETWORK_NAMES: Record<number, string> = {
  11155111: "Ethereum Sepolia",
  84532: "Base Sepolia",
  31337: "Local Anvil",
};
