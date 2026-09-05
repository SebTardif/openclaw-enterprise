#!/bin/sh
set -eu
trap 'exit 143' TERM INT

if [ "$#" -ne 1 ]; then
  echo "Usage: oce-start-tls /absolute/config.json" >&2
  exit 64
fi
case "$1" in
  /*) ;;
  *) echo "TLS configuration must use an absolute path" >&2; exit 64 ;;
esac

# DNS publishes its socket only after installing the real deny floor. Compose
# service creation alone does not mean the producer or authority is ready.
attempt=0
until /usr/local/bin/oce-egress --config "$1" --ready >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 20 ]; then
    echo "TLS startup refused: current authority or DNS enforcement unavailable" >&2
    exit 1
  fi
  sleep 1
done
exec /usr/local/bin/oce-egress --config "$1"
