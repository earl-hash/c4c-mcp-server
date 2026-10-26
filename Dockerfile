# C4C self-hosted regulatory MCP server. Build context: workers/mcp.
#   docker build -t c4c-mcp .
# A release image must contain server/library-public-key.pem, or it can never verify (so never install) a library.
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24-slim AS runtime

ENV NODE_ENV=production \
    C4C_DATA_DIR=/data \
    PORT=8080 \
    NODE_USE_ENV_PROXY=1

# The server never runs npm, corepack or yarn. Removing them drops their bundled
# dependencies, which are the image's only scanner findings (AWS Marketplace scans every layer).
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
      /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg

WORKDIR /app
COPY --from=deps /app/node_modules node_modules/
COPY package.json ./

COPY src/ src/
COPY server/ server/

# Fail the build when the public key is missing, unless the smoke test explicitly allows it.
ARG ALLOW_NO_PUBLIC_KEY=0
RUN if [ ! -f server/library-public-key.pem ] && [ "$ALLOW_NO_PUBLIC_KEY" != "1" ]; then \
      echo "ERROR: server/library-public-key.pem is missing. An image without it can never verify or install a library. Create the key (scripts/library-keygen.mjs), commit the public half, then rebuild. For a throwaway test image only: --build-arg ALLOW_NO_PUBLIC_KEY=1" >&2; \
      exit 1; \
    fi

RUN mkdir -p /data && chown node:node /data && chmod 1777 /tmp
USER 1000
# Declared volumes carry their ownership into platform-provided mounts (Fargate bind mounts start root-owned).
VOLUME /data /tmp
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node","--no-warnings=ExperimentalWarning","server/main.mjs"]

# Amazon Bedrock AgentCore Runtime edition: `docker build --target agentcore`, with a signed library
# (manifest.json, manifest.sig, corpus-<version>.sqlite) in agentcore-library/. AgentCore starts a fresh
# microVM per session, so the library ships in the image; the server still verifies its signature at start
# and still takes newer releases from C4C_LICENSE_KEY or a mirror C4C_UPDATE_URL when they are set.
FROM runtime AS agentcore
COPY --chown=1000:1000 agentcore-library/ /opt/c4c/library/
ENV C4C_BUNDLED_LIBRARY_DIR=/opt/c4c/library     PORT=8000

# Default target: the standard image.
FROM runtime
