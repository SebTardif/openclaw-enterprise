ARG EGRESS_BASE_IMAGE
FROM ${EGRESS_BASE_IMAGE}

ARG EGRESS_BASE_IMAGE
ENV NODE_ENV=production

# The package closure is downloaded and checked before this offline image build.
COPY deploy/egress/runtime-packages.lock.json /opt/oce/runtime-packages.lock.json
COPY deploy/egress/download-packages.mjs /opt/oce/download-packages.mjs
COPY .build/mvp/egress-debs/ /opt/oce/runtime-packages/
RUN node --input-type=module -e 'import {readFile} from "node:fs/promises"; import {verifyDirectory} from "/opt/oce/download-packages.mjs"; const lock=JSON.parse(await readFile("/opt/oce/runtime-packages.lock.json", "utf8")); if(process.arch!=="x64" || process.env.EGRESS_BASE_IMAGE!==lock.baseImage) process.exit(1); await verifyDirectory(lock, "/opt/oce/runtime-packages")' \
    && cd /opt/oce/runtime-packages \
    && sha256sum --strict --check SHA256SUMS \
    && dpkg --install ./*.deb \
    && test -s /etc/ssl/certs/ca-certificates.crt \
    && rm -rf /opt/oce/runtime-packages

# Only the two explicitly built OCE adapters enter the image. Stock DS entrypoints
# and host, VM, tap, mint, collector and shared-memory runtime paths are excluded.
COPY --chmod=0555 .build/mvp/native/oce-dnsgate /usr/local/bin/oce-dnsgate
COPY --chmod=0555 .build/mvp/native/oce-egress /usr/local/bin/oce-egress
COPY --chmod=0555 deploy/egress/start-tls.sh /usr/local/bin/oce-start-tls
RUN test "$(/usr/local/bin/oce-dnsgate --version | cut -d ' ' -f 1)" = oce-dnsgate \
    && test "$(/usr/local/bin/oce-egress --version | cut -d ' ' -f 1)" = oce-egress \
    && groupadd --gid 10002 oce-tls \
    && groupadd --gid 10003 oce-authority \
    && useradd --uid 10002 --gid 10002 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin oce-tls \
    && useradd --uid 10003 --gid 10003 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin oce-authority \
    && install --directory --owner=0 --group=0 --mode=0755 /run/oce-dns \
    && install --directory --owner=10003 --group=10003 --mode=0755 /run/oce-authority

USER 10002:10002
WORKDIR /opt/oce
EXPOSE 8443
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/oce-egress"]
CMD ["--version"]
