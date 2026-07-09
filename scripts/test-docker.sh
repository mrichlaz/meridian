#!/usr/bin/env bash
# Verify the Docker image has everything bot-tracker needs:
#   - Chromium binary at /usr/bin/chromium
#   - the .so deps puppeteer-core expects
#   - node can launch Chromium via puppeteer-core
#   - the in-house isBrowserConnected helper works against the launched
#     browser
#
# Usage:  bash scripts/test-docker.sh
# Or:     bash scripts/test-docker.sh --rebuild      (force a no-cache build)
#
# On success this prints a one-line OK and exits 0. On any failure it
# leaves the container running (with --rm removed) so you can `docker ps`
# and `docker logs` to debug.

set -euo pipefail

REBUILD=""
if [ "${1:-}" = "--rebuild" ]; then
  REBUILD="--no-cache"
fi

echo "=== Building image (this takes a few minutes on first run) ==="
docker compose build $REBUILD meridian 2>&1 | tail -20
# docker compose tags the image "<project>-<service>:latest" by default;
# capture the actual name so the smoke test below uses it.
IMAGE=$(docker compose config --images 2>/dev/null | head -1)
if [ -z "$IMAGE" ]; then
  # Fallback for older compose: derive from project dir.
  PROJECT=$(basename "$PWD")
  IMAGE="${PROJECT}-meridian:latest"
fi
echo
echo "=== Smoke test inside the container (image: $IMAGE) ==="

# Run a one-shot Node script that exercises the bits we just changed:
# isBrowserConnected, openBrowser, the bundled Chromium binary.
docker run --rm \
  -e BOT_TRACKER_DATA_DIR=/app/data \
  "$IMAGE" \
  node --input-type=module -e "
    import { isBrowserConnected } from '/app/tools/bot-tracker/stream-ingester.js';
    import puppeteer from 'puppeteer-core';
    import fs from 'node:fs';

    console.log('chromium binary present:', fs.existsSync('/usr/bin/chromium'));
    console.log('chromium version:', fs.execSync('/usr/bin/chromium --version 2>/dev/null || echo unknown').toString().trim());

    console.log('puppeteer-core version:', JSON.parse(fs.readFileSync('/app/node_modules/puppeteer-core/package.json', 'utf8')).version);

    const browser = await puppeteer.launch({
      executablePath: '/usr/bin/chromium',
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--single-process'],
    });
    console.log('browser launched OK, isBrowserConnected=', isBrowserConnected(browser));
    const page = await browser.newPage();
    await page.goto('about:blank');
    console.log('opened about:blank OK');
    await browser.close();
    console.log('SMOKE-TEST: OK');
  " 2>&1 | grep -vE "^(DevTools|\\$|>|\\s*$)"

echo
echo "=== Result: container test passed ==="
echo "Image: meridian:latest"
echo "Run 'docker compose up -d' to start the full stack."
