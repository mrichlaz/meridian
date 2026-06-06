FROM node:24-bookworm-slim

WORKDIR /app

RUN apt-get update -qq && apt-get install -y -qq \
    build-essential python3 git \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install && npm cache clean --force

COPY . .
RUN mkdir -p data logs

ENTRYPOINT ["/app/docker-entrypoint.sh"]
