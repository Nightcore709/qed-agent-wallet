# QED judge preview — bounded, valueless local Anvil only.
FROM node:22-bookworm-slim
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl tar \
    && rm -rf /var/lib/apt/lists/*
ARG TARGETARCH=amd64
ARG FOUNDRY_VERSION=v1.7.1
RUN set -eux; \
    case "$TARGETARCH" in "amd64"|"arm64") ;; *) echo "Unsupported CPU arch $TARGETARCH" >&2; exit 1;; esac; \
    curl -fSL "https://github.com/foundry-rs/foundry/releases/download/${FOUNDRY_VERSION}/foundry_${FOUNDRY_VERSION}_linux_${TARGETARCH}.tar.gz" -o /tmp/foundry.tgz; \
    tar -xzf /tmp/foundry.tgz -C /usr/local/bin anvil; \
    chmod +x /usr/local/bin/anvil; \
    rm /tmp/foundry.tgz; \
    anvil --version
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY --chown=node:node . .
RUN mkdir -p /app/evidence/demo-runs && chown -R node:node /app/evidence/demo-runs /app/node_modules
ENV QED_PUBLIC_DEMO=1
ENV QED_MAX_DEMO_RUNS=40
# The language model is used only when ANTHROPIC_API_KEY is set as a service secret; otherwise the labelled
# deterministic parser answers. Calls are capped (QED_MAX_LLM_CALLS, per-connection hourly limits).
ENV QED_MAX_LLM_CALLS=400
ENV QED_TRUST_PROXY=1
ENV PORT=4173
USER node
EXPOSE 4173
CMD ["npm","run","demo"]
