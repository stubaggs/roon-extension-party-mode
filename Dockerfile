# syntax=docker/dockerfile:1

# Base image: node:22-alpine, pinned by digest in both FROM lines below.
# Node 22 LTS (supported to April 2027) is the newest line that still ships
# 32-bit ARM (linux/arm/v7) images; Node 24 dropped it. The digest pin means a
# rebuild can't change the base silently, and Dependabot
# (.github/dependabot.yml) opens a pull request when the image is rebuilt with
# Alpine or Node fixes. It only sees images written out in FROM lines, so keep
# both lines identical rather than moving the image into an ARG.

# ---------------------------------------------------------------- build stage
# Installs dependencies exactly as locked and runs the tests. git is needed
# here because the Roon API packages come from GitHub; it never reaches the
# final image.
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS build
WORKDIR /usr/src/app

RUN apk add --no-cache git

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY app.js ./
COPY lib ./lib
COPY public ./public
COPY test ./test
RUN npm test

# -------------------------------------------------------------- final image
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

LABEL org.opencontainers.image.title="Roon Extension: Party Mode" \
      org.opencontainers.image.description="Roon Extension for parties: guests request music from their phone, no app needed" \
      org.opencontainers.image.source="https://github.com/stubaggs/roon-extension-party-mode" \
      org.opencontainers.image.licenses="Apache-2.0"

ENV NODE_ENV=production
WORKDIR /usr/src/app

COPY --from=build /usr/src/app/node_modules ./node_modules
COPY package.json app.js healthcheck.js ./
COPY lib ./lib
COPY public ./public

# Settings live in data/config.json, and config.json (where node-roon-api reads
# and writes them) links to it. A named volume mounted on data/ starts with
# this folder's contents and owner, so it is writable by node with nothing to
# set up first. A file bind-mounted at config.json, as the Extension Manager and
# installs before 1.4.0 do, still works: Docker follows the link and mounts it
# on data/config.json. No VOLUME instruction: it would give every Extension
# Manager install an anonymous volume it never uses.
# The extension needs only node at runtime, so npm, npx, corepack and yarn go:
# they are most of what vulnerability scanners report in a Node image, and a
# package manager is one less tool for anyone who gets into the container.
RUN mkdir data && touch data/config.json && chown -R node:node data \
 && ln -s data/config.json config.json \
 && rm -rf /usr/local/lib/node_modules /opt/yarn-* \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg

# Run as the image's unprivileged node user (uid 1000), like the Extension
# Manager and TheAppgineer's other extensions.
USER node

# Documentation only: the container runs with host networking, and the port
# can be changed in the extension's settings in Roon.
EXPOSE 8338

# Checks the web server on whatever port the settings say. Each check starts
# Node, which takes seconds on a Pi Zero or Pi 1, so the timings are generous:
# a tight timeout would report a slow Pi as unhealthy, and frequent checks
# would take CPU from serving guests.
HEALTHCHECK --interval=60s --timeout=15s --start-period=60s --retries=3 \
  CMD ["node", "healthcheck.js"]

# app.js exits cleanly on SIGTERM, so `docker stop` doesn't need an init process.
CMD ["node", "app.js"]
