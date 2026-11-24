# syntax=docker/dockerfile:1.7
# QED, the deployable image (docs/DEPLOY.md). One container runs the API, the engine and the wallet service with its
# local test chain, each in its own process under scripts/deploy/supervise.ts, on one volume mounted at /data.
#
# Built from the REPOSITORY ROOT (the context holds apps/qed-demo, the two research files the readiness page reads and
# the five QA files the judge page reads;
# the root .dockerignore keeps everything else out, data folders, keys and dependency folders included):
#   docker build -f apps/qed-demo/Dockerfile --build-arg QED_REVISION=$(git rev-parse HEAD) -t qed-demo .
#
# Pinned: Node 26.13.1 (the same version as .nvmrc and package.json engines; the local rehearsals ran on 26.12.0), Foundry v1.7.1
# (forge builds the owner-account contract, anvil runs the local chain), solc 0.8.38 (fetched by forge and checked
# against the compiler list). Pin both base images by digest at the first build (docs/DEPLOY.md, check H-1).

ARG NODE_IMAGE=node:26.13.1-bookworm-slim
ARG FOUNDRY_IMAGE=ghcr.io/foundry-rs/foundry:v1.7.1

# ---- the owner-account contract, built as chain/accounts/READY.json declares it; the build stops unless its SHA-256 matches
FROM ${FOUNDRY_IMAGE} AS accounts
USER root
ENV HOME=/root FORGE_OFFLINE=1
# solc from the official release binaries, pinned by SHA-256 from binaries.soliditylang.org/linux-amd64/list.json (read
# 25 Nov 2026), placed where forge looks for installed compilers. forge's own download failed inside this build ("No solc
# version exists that matches =0.8.38", 25 Nov 2026), and a checked, offline compiler keeps the build reproducible.
# linux/amd64 only (Railway builds amd64; build locally with --platform linux/amd64).
ADD --checksum=sha256:65c3180a336eabb6bdc4bbd49cc405aeb233976964ae6c11fba2a6c8be8f3243 https://binaries.soliditylang.org/linux-amd64/solc-linux-amd64-v0.8.38+commit.1835d247 /root/.svm/0.8.38/solc-0.8.38
ADD --checksum=sha256:d5f23436f443edb85d8e76906d12f0a86ce0490e7663a9e608efeb7a93f149ef https://binaries.soliditylang.org/linux-amd64/solc-linux-amd64-v0.8.26+commit.8a97fa7a /root/.svm/0.8.26/solc-0.8.26
RUN chmod 0755 /root/.svm/0.8.38/solc-0.8.38 /root/.svm/0.8.26/solc-0.8.26
WORKDIR /src/apps/qed-demo
COPY apps/qed-demo/chain/accounts chain/accounts
COPY apps/qed-demo/chain/vendor chain/vendor
COPY apps/qed-demo/scripts/deploy/build-owner-account.sh scripts/deploy/build-owner-account.sh
RUN sh scripts/deploy/build-owner-account.sh

# ---- the interface and the Node dependencies, from the lockfiles only
FROM ${NODE_IMAGE} AS build
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
WORKDIR /src/apps/qed-demo
COPY apps/qed-demo/package.json apps/qed-demo/package-lock.json apps/qed-demo/.npmrc ./
RUN npm ci --ignore-scripts
COPY apps/qed-demo/chain/package.json apps/qed-demo/chain/package-lock.json chain/
RUN cd chain && npm ci --ignore-scripts --omit=dev
COPY apps/qed-demo ./
RUN npm run build && npm prune --omit=dev --ignore-scripts

# ---- the runtime: Node, tini as process 1, the anvil binary, the built app; no compiler, no dev dependencies, no keys
FROM ${NODE_IMAGE} AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends tini procps && rm -rf /var/lib/apt/lists/* && command -v setpriv \
 && useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin qedcosign
# R13 review fix F3: the co-signer runs as its own unprivileged user (qedcosign), which can read neither the service's key
# folder, nor its data folder, nor its processes' /proc entries (scripts/deploy/entrypoint.sh; docs/LEAST-PRIVILEGE.md).
COPY --from=accounts /usr/local/bin/anvil /usr/local/bin/anvil
WORKDIR /app/apps/qed-demo
COPY --from=build /src/apps/qed-demo/package.json /src/apps/qed-demo/package-lock.json ./
COPY --from=build /src/apps/qed-demo/node_modules node_modules
COPY --from=build /src/apps/qed-demo/dist dist
COPY --from=build /src/apps/qed-demo/server server
COPY --from=build /src/apps/qed-demo/shared shared
COPY --from=build /src/apps/qed-demo/scripts scripts
COPY --from=build /src/apps/qed-demo/register register
COPY --from=build /src/apps/qed-demo/evidence evidence
COPY --from=build /src/apps/qed-demo/chain chain
COPY --from=accounts /src/apps/qed-demo/chain/accounts/out/QEDOwnerAccount.sol/QEDOwnerAccount.json chain/accounts/out/QEDOwnerAccount.sol/QEDOwnerAccount.json
COPY docs/shared/RISK_REGISTER.md /app/docs/shared/RISK_REGISTER.md
COPY docs/research/qed-fin-infra-compliance/20261123-jurisdiction-matrix.json /app/docs/research/qed-fin-infra-compliance/20261123-jurisdiction-matrix.json
COPY docs/research/qed-qa-reliability/20261124-adversarial-ask-live-original30.json docs/research/qed-qa-reliability/20261124-adversarial-ask-live-diagnosis.json docs/research/qed-qa-reliability/20261124-adversarial-ask-live-rerun.json docs/research/qed-qa-reliability/20261124-adversarial-ask-live-rerun-diagnosis.json /app/docs/research/qed-qa-reliability/
COPY docs/research/qed-qa-reliability/runs/adversarial-live-calls.tsv /app/docs/research/qed-qa-reliability/runs/adversarial-live-calls.tsv
# The revision: given by the builder, else Railway's commit variable (set when the deploy comes from GitHub).
ARG QED_REVISION=""
ARG RAILWAY_GIT_COMMIT_SHA=""
RUN echo "${QED_REVISION:-$RAILWAY_GIT_COMMIT_SHA}" > REVISION \
 && anvil --version | head -1 && node --version \
 && test -f dist/index.html && test -f chain/accounts/out/QEDOwnerAccount.sol/QEDOwnerAccount.json \
 && test -f /app/docs/shared/RISK_REGISTER.md && test -f /app/docs/research/qed-fin-infra-compliance/20261123-jurisdiction-matrix.json \
 && test -f /app/docs/research/qed-qa-reliability/runs/adversarial-live-calls.tsv \
 && chmod 755 scripts/deploy/entrypoint.sh
# TSX_DISABLE_CACHE: tsx keeps compiled code only in memory, never in a shared /tmp cache another process of the same
# user could rewrite for the wallet service or the co-signer to load (independent review of the fixes, M2, 25 Nov 2026).
ENV NODE_ENV=production \
    QED_LOG_FORMAT=json \
    QED_HOST=0.0.0.0 \
    PORT=8080 \
    QED_DATA_DIR=/data \
    QED_RAIL_ANVIL=/usr/local/bin/anvil \
    QED_AI_PROVIDER=none \
    QED_DELIVERY=none \
    TSX_DISABLE_CACHE=1
EXPOSE 8080
# Liveness only (the API answers /api/live on loopback); no curl or shell needed. Docker, Compose and similar hosts use it;
# Railway's documented check is its own, of /api/ready at deploy; its docs do not mention a Dockerfile HEALTHCHECK (read 24 Nov 2026), so do not rely on this there. Start period 90 s
# covers the first start (keyrings, wallet-service sealing, chain deploy). docs/DEPLOY.md, "Runtime hardening".
HEALTHCHECK --interval=30s --timeout=6s --start-period=90s --retries=3 CMD ["node", "/app/apps/qed-demo/scripts/deploy/healthcheck.ts"]
STOPSIGNAL SIGTERM
# The entrypoint hands QED_KEK off to a private file and then execs tini as process 1, so that no process, tini
# included, starts with the key in its environment (R13 review fix F3); tini then runs the entrypoint again as its child.
ENTRYPOINT ["/app/apps/qed-demo/scripts/deploy/entrypoint.sh"]
