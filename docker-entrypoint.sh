#!/bin/sh
# docker-entrypoint.sh — bridge Docker/Swarm secrets to the environment.
#
# Swarm mounts a `secret` as a FILE under /run/secrets/<name>, but the FlightDeck
# server reads FLIGHTDECK_INGEST_TOKEN (and the optional FLIGHTDECK_DISCORD_TOKEN)
# from the ENVIRONMENT. This shim implements the standard `<VAR>_FILE` convention:
# if FLIGHTDECK_INGEST_TOKEN_FILE points at a readable file and the bare var is
# unset, it reads the file's contents into FLIGHTDECK_INGEST_TOKEN, then exec's
# the real command. This is packaging glue ONLY — src/server.ts is unchanged and
# still just reads the bare env vars. A plain `docker run` that sets the bare vars
# directly is unaffected (the *_FILE vars are simply absent).
set -eu

# For each secret-backed var, expand its *_FILE companion when the bare var is
# unset. Trailing newlines from `docker secret create < file` are stripped so the
# token compares byte-for-byte against what the emitters send.
for var in FLIGHTDECK_INGEST_TOKEN FLIGHTDECK_DISCORD_TOKEN; do
  file_var="${var}_FILE"
  eval "file_path=\${${file_var}:-}"
  [ -n "$file_path" ] || continue
  if [ ! -r "$file_path" ]; then
    echo "[flightdeck-entrypoint] FATAL: ${file_var}=${file_path} is not readable" >&2
    exit 1
  fi
  eval "current=\${${var}:-}"
  if [ -z "$current" ]; then
    # Read the file and strip a single trailing newline.
    value="$(cat "$file_path")"
    export "${var}=${value}"
  fi
done

exec "$@"
