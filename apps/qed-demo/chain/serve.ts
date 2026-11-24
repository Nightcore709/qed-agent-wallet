/**
 * Starts the chain rail's loopback service:   node apps/qed-demo/chain/serve.ts     (or: npm start, in chain/)
 *
 * This file is plain erasable TypeScript, so Node 26 runs it directly. Its only job is to register tsx, the
 * release's own pinned loader (4.19.2), before the release's vendored TypeScript is imported: that code uses ".js"
 * import specifiers for ".ts" files and constructor parameter properties, which Node's type stripping does not
 * handle. On Node 26 tsx prints one deprecation notice (DEP0205, module.register); it is harmless today.
 */
import { register } from "tsx/esm/api";
import { reexecWithoutKek } from "../server/kek-handoff.ts";

// R13 review fix F3 (i): started with QED_KEK, the wallet service writes it to a private file and re-executes without it,
// so that no process of the same user (the co-signer it starts among them) can read it from its initial environment.
reexecWithoutKek(process.env.QED_SECRETS_DIR ?? "/run/qed");
register();
const { main } = await import("./rail/main.ts");
await main();
