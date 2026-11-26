FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c
WORKDIR /opt/dsh
# Copy before installing to avoid copying the large native runtime again on VFS.
COPY --chmod=0444 package.json package-lock.json profile.json writing.patch.yml guard.mjs runner.mjs policy.mjs relay.mjs ./
RUN --mount=type=secret,id=build_ca sh -c 'if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; npm ci --ignore-scripts --omit=dev --no-audit --no-fund && npm cache clean --force'
USER 1000:1000
ENTRYPOINT ["node", "/opt/dsh/runner.mjs"]
