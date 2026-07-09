FROM node:24-bookworm-slim

WORKDIR /app

# build-essential + python3: needed for native modules (better-sqlite3).
# chromium + fonts + deps: needed for the bot-tracker's stream-ingester
# (puppeteer-core drives a headless Chromium to keep the sandwiched.me WS
# alive through Cloudflare; Lightpanda was tested and rejected because CF
# blocks it). The full debian package pulls the .so deps puppeteer needs
# at runtime.
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
    build-essential python3 \
    chromium fonts-liberation libnss3 libatk1.0-0 libatk-bridge2.0-0 \
    libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
    libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 \
    ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# Copy package files + scripts for postinstall
COPY package*.json ./
COPY scripts scripts/
RUN npm install --loglevel=warn && npm cache clean --force

COPY . .
RUN mkdir -p data logs && chmod +x docker-entrypoint.sh

# Sanity-check the Chromium install so a build with a broken apt cache fails
# here rather than at runtime. The stream-ingester's findBrowserExecutable()
# probes /usr/bin/chromium and falls back to channel: 'chrome' if missing.
RUN /usr/bin/chromium --version || echo "WARN: chromium not found at /usr/bin/chromium, stream-ingester will use channel:chrome"

ENTRYPOINT ["/app/docker-entrypoint.sh"]
