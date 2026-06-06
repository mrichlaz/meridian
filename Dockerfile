FROM node:24-slim

WORKDIR /app

# Install build deps for better-sqlite3 native compilation
RUN apt-get update -qq && apt-get install -y -qq \
    python3 make g++ git \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

RUN chmod +x docker-entrypoint.sh

# Ensure data & logs directories exist at runtime
RUN mkdir -p data logs

ENTRYPOINT ["/app/docker-entrypoint.sh"]
