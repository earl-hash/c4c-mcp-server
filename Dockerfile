# C4C self-hosted regulatory MCP server. Build context: workers/mcp.
#   docker build -t c4c-mcp .
# A release image must contain server/library-public-key.pem, or it can never verify (so never install) a library.
FROM node:24-slim

ENV NODE_ENV=production \
    C4C_DATA_DIR=/data \
    PORT=8080 \
    NODE_USE_ENV_PROXY=1

WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src/ src/
COPY server/ server/

# Fail the build when the public key is missing, unless the smoke test explicitly allows it.
ARG ALLOW_NO_PUBLIC_KEY=0
RUN if [ ! -f server/library-public-key.pem ] && [ "$ALLOW_NO_PUBLIC_KEY" != "1" ]; then \
      echo "ERROR: server/library-public-key.pem is missing. An image without it can never verify or install a library. Create the key (scripts/library-keygen.mjs), commit the public half, then rebuild. For a throwaway test image only: --build-arg ALLOW_NO_PUBLIC_KEY=1" >&2; \
      exit 1; \
    fi

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node","--no-warnings=ExperimentalWarning","server/main.mjs"]
