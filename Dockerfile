FROM node:24-bookworm-slim

WORKDIR /app

# Install build tools for better-sqlite3 native compilation (~2-3 min)
RUN apt-get update -qq && apt-get install -y -qq \
    build-essential python3 \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN echo "Building native modules (better-sqlite3)... this takes 2-3 min" \
    && npm install --loglevel=warn \
    && npm cache clean --force

COPY . .
RUN mkdir -p data logs

ENTRYPOINT ["/app/docker-entrypoint.sh"]
