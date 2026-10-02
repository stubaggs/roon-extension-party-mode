# syntax=docker/dockerfile:1

# Node 22 LTS (supported to April 2027) is the newest line that still ships
# 32-bit ARM (linux/arm/v7) images; Node 24 dropped it. Pinned by digest so a
# rebuild can't change the base silently; bump the tag and digest together.
ARG NODE_IMAGE=node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

# ---------------------------------------------------------------- build stage
# Installs dependencies exactly as locked and runs the tests. git is needed
# here because the Roon API packages come from GitHub; it never reaches the
# final image.
FROM ${NODE_IMAGE} AS build
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
FROM ${NODE_IMAGE}

LABEL org.opencontainers.image.title="Roon Extension: Party Mode" \
      org.opencontainers.image.description="Lets guests search your library and add tracks to a zone's queue from their phone" \
      org.opencontainers.image.source="https://github.com/stubaggs/roon-extension-party-mode" \
      org.opencontainers.image.licenses="Apache-2.0"

ENV NODE_ENV=production
WORKDIR /usr/src/app

COPY --from=build /usr/src/app/node_modules ./node_modules
COPY package.json app.js healthcheck.js ./
COPY lib ./lib
COPY public ./public

# The Extension Manager bind-mounts this file so settings survive image updates.
RUN touch config.json

# Documentation only: the container runs with host networking, and the port
# can be changed in the extension's settings in Roon.
EXPOSE 8080

# Checks the web server on whatever port the settings say.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "healthcheck.js"]

# app.js exits cleanly on SIGTERM, so `docker stop` doesn't need an init process.
CMD ["node", "app.js"]
