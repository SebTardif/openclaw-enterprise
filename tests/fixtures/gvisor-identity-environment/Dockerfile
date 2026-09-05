# The operator supplies an independently reviewed, locally cached amd64 digest.
# No build step executes the fixture or retrieves dependencies.
ARG BASE_IMAGE
FROM ${BASE_IMAGE} AS node-source
FROM node-source AS fixture-base

# Compute invokes `node -e` in its init container, bypassing image CMD. The
# wrapper therefore applies the same inherited limits to every Node entry.
COPY --from=node-source --chown=0:0 --chmod=0555 /usr/local/bin/node /usr/local/bin/node-real
COPY --chown=0:0 --chmod=0555 node-wrapper.sh /usr/local/bin/node

# An absolute deadline survives container restarts. Missing/expired values fail
# closed in both launchers; the exact value belongs in the reviewed build packet.
ARG FIXTURE_EXPIRES_AT
ENV OCE_RUN11_EXPIRES_AT=${FIXTURE_EXPIRES_AT} \
    NODE_OPTIONS="" \
    NODE_PATH="" \
    UV_THREADPOOL_SIZE=2

WORKDIR /fixture
USER 1000:1000
EXPOSE 8080

FROM fixture-base AS gateway
COPY --chown=0:0 --chmod=0444 gateway.mjs /fixture/gateway.mjs
ENTRYPOINT []
CMD ["/usr/local/bin/node", "--max-old-space-size=64", "/fixture/gateway.mjs"]

FROM fixture-base AS agent
COPY --chown=0:0 --chmod=0555 codex-x86_64-unknown-linux-musl /usr/local/bin/codex
COPY --chown=0:0 --chmod=0444 launcher.mjs /fixture/launcher.mjs
ENTRYPOINT []
CMD ["/usr/local/bin/node", "--max-old-space-size=64", "/fixture/launcher.mjs"]
