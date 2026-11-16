# syntax=docker/dockerfile:1.7
FROM node:24.22.1-bookworm-slim AS dependencies
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /app
RUN --mount=type=secret,id=build_ca sh -c 'if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; npm install --global pnpm@11.25.0'
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/desktop/package.json apps/desktop/package.json
COPY packages/ packages/
COPY workers/ workers/
RUN --mount=type=secret,id=build_ca sh -c 'if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; pnpm install --frozen-lockfile'
COPY apps/web/ apps/web/
RUN pnpm --filter @scenesparrow/web build

FROM rust:1.100.0-bookworm AS core
WORKDIR /app
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates/ crates/
RUN --mount=type=secret,id=build_ca sh -c 'if [ -f /run/secrets/build_ca ]; then export CARGO_HTTP_CAINFO=/run/secrets/build_ca SSL_CERT_FILE=/run/secrets/build_ca; fi; cargo build --release --locked -p scenesparrow-service'

FROM node:24.22.1-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3 libfontconfig1 libfreetype6 fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Keep the build-time workspace path: Rust workers use CARGO_MANIFEST_DIR.
COPY --from=dependencies /app/node_modules/ node_modules/
COPY --from=dependencies /app/packages/ packages/
COPY --from=dependencies /app/workers/ workers/
COPY --from=dependencies /app/package.json package.json
COPY --from=dependencies /app/apps/web/dist/ apps/web/dist/
COPY --from=core /app/target/release/scenesparrow-service bin/scenesparrow-service
COPY scripts/web/ scripts/web/
RUN mkdir -p /app/crates/infrastructure /data/project /data/app && chmod -R a+rX /app && chown -R node:node /data
ENV NODE_ENV=production
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=40s --retries=6 CMD ["node", "-e", "fetch('http://127.0.0.1:8080/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "scripts/web/start.mjs"]
