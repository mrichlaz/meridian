#!/bin/sh
# Fix Docker bind-mount dirs created for non-existent files
for f in state.json lessons.json pool-memory.json token-blacklist.json \
         strategy-library.json decision-log.json signal-weights.json \
         smart-wallets.json hivemind-cache.json; do
  if [ -d "/app/$f" ]; then
    rm -rf "/app/$f"
    echo "{}" > "/app/$f"
  fi
done

mkdir -p /app/data /app/logs

exec node index.js
