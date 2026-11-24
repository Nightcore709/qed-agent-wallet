/**
 * R13 review fix F3: the signer of the co-signer's self-test (an EIP-191 signature of one fixed text, cosigner.ts
 * COSIGNER_SELF_TEST), for the deployed image's isolation check (scripts/deploy/isolation-check.ts). Kept here so that
 * viem resolves from the chain package, where it is a dependency.
 */
import { getAddress, recoverMessageAddress, type Address, type Hex } from "viem";

export async function selfTestSigner(message: string, signature: Hex): Promise<Address> {
  return getAddress(await recoverMessageAddress({ message, signature }));
}
