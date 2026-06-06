FROM node:24-bookworm-slim

WORKDIR /app

RUN apt-get update -qq && apt-get install -y -qq \
    build-essential python3 \
    && rm -rf /var/lib/apt/lists/*

# Copy package files + scripts for postinstall
COPY package*.json ./
COPY scripts scripts/
RUN npm install --loglevel=warn && npm cache clean --force

COPY . .
RUN mkdir -p data logs && chmod +x docker-entrypoint.sh

ENTRYPOINT ["/app/docker-entrypoint.sh"]
