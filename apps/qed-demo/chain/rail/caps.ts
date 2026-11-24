/**
 * R13 review fix F3 (iii). In the container the supervisor, and the wallet service it starts, hold CAP_SETUID and
 * CAP_SETGID (ambient, the bounding set reduced to those two, no new privileges: scripts/deploy/entrypoint.sh) for one
 * purpose only: the wallet service starts the co-signer as its own unprivileged user (cosigner-env.ts cosignerCommand).
 * Every other child (the API, the engine, the one-off commands, the local chains, an economy's agent) is started through
 * setpriv with its inheritable and ambient capabilities cleared, so that it holds none. Outside the container
 * (QED_COSIGNER_UID unset) a command is returned unchanged. No imports, so that a test reads exactly what is used.
 */
export function withoutCaps(file: string, args: string[], env: Record<string, string | undefined> = process.env): { file: string; args: string[] } {
  if (!env.QED_COSIGNER_UID) return { file, args };
  return { file: env.QED_SETPRIV || "/usr/bin/setpriv", args: ["--inh-caps=-all", "--ambient-caps=-all", "--", file, ...args] };
}
