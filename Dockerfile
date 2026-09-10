# Operators must select an approved, immutable Node 24 base image explicitly.
ARG NODE_BASE_IMAGE
# Operators must also select an approved, immutable Go 1.26 build image.
ARG GO_BASE_IMAGE
FROM ${GO_BASE_IMAGE} AS native-build
ENV GOTOOLCHAIN=local
WORKDIR /src
COPY components/runtime-security/go.mod components/runtime-security/go.sum ./
RUN go mod download
COPY components/runtime-security/ ./
# An explicit worktree namespace enables compiler reuse across source changes.
# Keep direct callers' ordinary Go cache behavior when the scope is omitted.
ARG GO_BUILD_CACHE_SCOPE
ARG GO_BASE_IMAGE
ARG TARGETPLATFORM
RUN --mount=type=cache,id=oce-go-${GO_BUILD_CACHE_SCOPE}-${GO_BASE_IMAGE}-${TARGETPLATFORM},target=/var/cache/oce-go-build,sharing=locked \
    if [ -n "$GO_BUILD_CACHE_SCOPE" ]; then export GOCACHE=/var/cache/oce-go-build; fi; \
    CGO_ENABLED=0 go build -mod=readonly -trimpath -buildvcs=false -ldflags="-s -w" -o /out/oce-runtime-security ./cmd/oce-runtime-security
RUN --mount=type=cache,id=oce-go-${GO_BUILD_CACHE_SCOPE}-${GO_BASE_IMAGE}-${TARGETPLATFORM},target=/var/cache/oce-go-build,sharing=locked \
    if [ -n "$GO_BUILD_CACHE_SCOPE" ]; then export GOCACHE=/var/cache/oce-go-build; fi; \
    CGO_ENABLED=0 go build -mod=readonly -trimpath -buildvcs=false -ldflags="-s -w" -o /out/oce-runtime-authority ./cmd/oce-runtime-authority
RUN --mount=type=cache,id=oce-go-${GO_BUILD_CACHE_SCOPE}-${GO_BASE_IMAGE}-${TARGETPLATFORM},target=/var/cache/oce-go-build,sharing=locked \
    if [ -n "$GO_BUILD_CACHE_SCOPE" ]; then export GOCACHE=/var/cache/oce-go-build; fi; \
    CGO_ENABLED=0 go build -mod=readonly -trimpath -buildvcs=false -ldflags="-s -w" -o /out/oce-clock-observation ./cmd/oce-clock-observation
RUN --mount=type=cache,id=oce-go-${GO_BUILD_CACHE_SCOPE}-${GO_BASE_IMAGE}-${TARGETPLATFORM},target=/var/cache/oce-go-build,sharing=locked \
    if [ -n "$GO_BUILD_CACHE_SCOPE" ]; then export GOCACHE=/var/cache/oce-go-build; fi; \
    CGO_ENABLED=0 go build -mod=readonly -trimpath -buildvcs=false -ldflags="-s -w" -o /out/oce-github-mediation ./cmd/oce-github-mediation
RUN chmod 0555 /out/oce-runtime-authority /out/oce-clock-observation /out/oce-github-mediation
RUN sh licenses/collect.sh /out/licenses

# Consume a separately frozen package-input context, never the host .build tree.
FROM ${NODE_BASE_IMAGE} AS upstream-sdk
WORKDIR /app
ARG OCE_UPSTREAM_SDK_MANIFEST_SHA256
COPY --from=oce-upstream-inputs / /opt/oce-upstream-inputs/
COPY scripts/prepare-upstream-sdk.mjs scripts/prepare-upstream-sdk.mjs
RUN node -e "const [major, minor] = process.versions.node.split('.').map(Number); if (major !== 24 || minor < 15) throw new Error('The selected upstream package requires Node.js 24.15.0 or newer within Node.js 24.')"
RUN mkdir -p /app/.build \
    && node scripts/prepare-upstream-sdk.mjs \
      --manifest /opt/oce-upstream-inputs/layout.json \
      --sha256 "$OCE_UPSTREAM_SDK_MANIFEST_SHA256" \
      --output /app/.build/upstream-sdk

FROM ${NODE_BASE_IMAGE} AS dependencies

WORKDIR /app
RUN node -e "if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('The approved production base image must use Node.js 24.')"
COPY LICENSE package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/controller/package.json apps/controller/package.json
COPY packages/audit/package.json packages/audit/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/iam/package.json packages/iam/package.json
COPY packages/occ/package.json packages/occ/package.json
COPY packages/utils/package.json packages/utils/package.json
COPY --from=upstream-sdk /app/.build/upstream-sdk /app/.build/upstream-sdk
COPY --from=upstream-sdk /opt/oce-upstream-inputs/dependencies /opt/oce-upstream-inputs/dependencies
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    corepack pnpm install --frozen-lockfile --prod --ignore-scripts

FROM dependencies AS development
COPY --from=native-build /out/oce-runtime-security /usr/local/bin/oce-runtime-security
COPY --from=native-build /out/oce-runtime-authority /usr/local/bin/oce-runtime-authority
COPY --from=native-build /out/oce-clock-observation /usr/local/bin/oce-clock-observation
COPY --from=native-build /out/oce-github-mediation /usr/local/bin/oce-github-mediation
COPY --from=native-build /out/licenses /usr/share/licenses/oce-runtime-security
ENV NODE_ENV=development
WORKDIR /app

COPY --chown=node:node package.json pnpm-workspace.yaml ./
COPY --chown=node:node packages packages
COPY --chown=node:node apps/controller apps/controller
COPY --chown=node:node migrations migrations
COPY --chown=node:node scripts scripts
RUN mkdir -p /app/.development/configurations /var/lib/openclaw/bootstrap \
    && chown -R node:node /app/.development \
    && chown 1000:1000 /var/lib/openclaw/bootstrap \
    && chmod 0700 /var/lib/openclaw/bootstrap

USER node
ENTRYPOINT ["node"]
CMD ["apps/controller/src/server.mjs"]

FROM ${NODE_BASE_IMAGE} AS runtime
COPY --from=native-build /out/oce-runtime-security /usr/local/bin/oce-runtime-security
COPY --from=native-build /out/oce-runtime-authority /usr/local/bin/oce-runtime-authority
COPY --from=native-build /out/oce-clock-observation /usr/local/bin/oce-clock-observation
COPY --from=native-build /out/oce-github-mediation /usr/local/bin/oce-github-mediation
COPY --from=native-build /out/licenses /usr/share/licenses/oce-runtime-security
ENV NODE_ENV=production
WORKDIR /app

COPY --from=dependencies --chown=node:node /app/ ./
COPY --from=dependencies /opt/oce-upstream-inputs/dependencies /opt/oce-upstream-inputs/dependencies
COPY --chown=node:node package.json pnpm-workspace.yaml ./
COPY --chown=node:node packages/audit/package.json packages/audit/package.json
COPY --chown=node:node packages/audit/src packages/audit/src
COPY --chown=node:node packages/contracts/package.json packages/contracts/package.json
COPY --chown=node:node packages/contracts/src packages/contracts/src
COPY --chown=node:node packages/iam/package.json packages/iam/package.json
COPY --chown=node:node packages/iam/src packages/iam/src
COPY --chown=node:node packages/occ/package.json packages/occ/package.json
COPY --chown=node:node packages/occ/src packages/occ/src
COPY --chown=node:node packages/utils/package.json packages/utils/package.json
COPY --chown=node:node packages/utils/src packages/utils/src
COPY --chown=node:node apps/controller/src apps/controller/src
COPY --chown=node:node migrations/[0-9]*.sql migrations/
COPY --chown=node:node migrations/meta/_journal.json migrations/meta/_journal.json
COPY --chown=node:node scripts/migrate-production.mjs scripts/migrate-production.mjs
COPY --chown=node:node scripts/turn-journal-phase-upgrade.mjs scripts/turn-journal-phase-upgrade.mjs
COPY --chown=node:node scripts/bootstrap-installation.mjs scripts/bootstrap-installation.mjs
COPY --chown=node:node scripts/production-healthcheck.mjs scripts/production-healthcheck.mjs

USER node
ENTRYPOINT ["node"]
CMD ["apps/controller/src/server.mjs"]
