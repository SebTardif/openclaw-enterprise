ARG NODE_BASE_IMAGE=docker.io/library/node:24-bookworm@sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584
FROM ${NODE_BASE_IMAGE} AS packages

WORKDIR /prepare
COPY . .
RUN node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major !== 24 || minor < 15) throw new Error(`OpenClaw Enterprise runtime images require Node.js 24.15+; found ${process.version}.`);' \
  && node verify-context.mjs --verify-context /prepare \
  && mkdir -p /prepare/native \
  && npm ci --offline --omit=dev --ignore-scripts --no-audit --no-fund \
    --userconfig /prepare/empty.npmrc --globalconfig /prepare/empty-global.npmrc \
    --cache /prepare/cache

FROM ${NODE_BASE_IMAGE}

ENV NODE_ENV=production
ENV PATH=/app/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

WORKDIR /app
COPY --from=packages /prepare/node_modules ./node_modules
COPY --from=packages /prepare/package.json /prepare/package-lock.json ./

# Optional READ selection is verified before installation. The original builder
# record describes compilation/staging, not a final-image identity or authority.
COPY --from=packages /prepare/native/ /opt/openclaw-read-staging/
COPY --from=packages /prepare/verify-context.mjs /opt/openclaw-read-verifier.mjs
RUN if test -f /opt/openclaw-read-staging/read-installation.json; then \
      node /opt/openclaw-read-verifier.mjs --verify-read-staging /opt/openclaw-read-staging \
      && install -o 0 -g 0 -m 0555 /opt/openclaw-read-staging/oce-github-read /usr/local/bin/oce-github-read \
      && install -D -o 0 -g 0 -m 0444 /opt/openclaw-read-staging/read-native-build.json /usr/local/share/openclaw/read-native-build.json \
      && node /opt/openclaw-read-verifier.mjs --verify-read-installed /opt/openclaw-read-staging; \
    else test -z "$(find /opt/openclaw-read-staging -mindepth 1 -print -quit)"; fi \
  && rm -rf /opt/openclaw-read-staging /opt/openclaw-read-verifier.mjs

RUN mkdir -p node_modules/openclaw/dist/extensions ./plugin-skills /etc/openclaw /home/node/.codex/generated_images \
  && chown node:node /home/node/.codex /home/node/.codex/generated_images \
  && chmod 700 /home/node/.codex /home/node/.codex/generated_images \
  && cp -R node_modules/@openclaw/codex node_modules/openclaw/dist/extensions/codex \
  && cp -R node_modules/@openclaw/slack node_modules/openclaw/dist/extensions/slack \
  && cp -R node_modules/@openclaw/msteams node_modules/openclaw/dist/extensions/msteams \
  && cp -R node_modules/@openclaw/slack/skills/slack ./plugin-skills/slack \
  && ln -s node_modules/openclaw/openclaw.mjs ./openclaw.mjs \
  && ln -s node_modules/openclaw/dist ./dist \
  && cp -R node_modules/openclaw/skills ./skills \
  && chmod -R a+rX /app \
  && test -L /app/dist \
  && test -d /app/skills \
  && test ! -L /app/skills \
  && test -d /app/plugin-skills/slack \
  && test "$(stat -c '%U:%G:%a' /home/node/.codex)" = "node:node:700" \
  && test "$(stat -c '%U:%G:%a' /home/node/.codex/generated_images)" = "node:node:700" \
  && node /app/openclaw.mjs --version \
  && test "$(codex --version)" = "codex-cli 0.153.0" \
  && test -f /app/dist/extensions/codex/openclaw.plugin.json \
  && test -f /app/dist/extensions/slack/openclaw.plugin.json \
  && test -f /app/dist/extensions/msteams/openclaw.plugin.json \
  && test -f /app/dist/extensions/codex/index.js \
  && test -f /app/dist/extensions/slack/index.js \
  && test -f /app/dist/extensions/msteams/index.cjs

USER node
