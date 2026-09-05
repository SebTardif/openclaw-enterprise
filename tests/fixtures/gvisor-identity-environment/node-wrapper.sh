#!/bin/sh
set -eu
ulimit -n 256
ulimit -c 0
exec /usr/local/bin/node-real "$@"
