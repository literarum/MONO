#!/bin/sh
set -eu
export MONO_PROXY_SECRET="$(cat /run/secrets/mono_proxy_secret)"
[ "${#MONO_PROXY_SECRET}" -ge 32 ] || { echo 'Invalid proxy secret' >&2; exit 1; }
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
