#!/bin/bash
# Run Meridian locally with Docker
# Set up data dir + bind mount .env

cd "$(dirname "$0")"
mkdir -p data logs

# Ensure state files exist in data/
for f in state.json lessons.json pool-memory.json token-blacklist.json \
         strategy-library.json decision-log.json signal-weights.json \
         smart-wallets.json hivemind-cache.json; do
  [ -f "data/$f" ] || echo "{}" > "data/$f"
done

# Build if not already built
if ! docker images meridian-local | grep -q meridian-local; then
  echo "Building meridian-local..."
  docker build -t meridian-local .
fi

echo "Starting Meridian in Docker..."
docker run --rm -it \
  --name meridian \
  -v "$(pwd)/.env:/app/.env:ro" \
  -v "$(pwd)/user-config.json:/app/user-config.json:ro" \
  -v "$(pwd)/data:/app/data" \
  -v "$(pwd)/logs:/app/logs" \
  -e NODE_ENV=production \
  meridian-local node index.js
