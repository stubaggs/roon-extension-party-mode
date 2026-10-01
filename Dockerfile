FROM node:20-alpine

WORKDIR /usr/src/app

COPY package.json ./
RUN apk add --no-cache git \
    && npm install --omit=dev \
    && apk del git \
    && npm cache clean --force

COPY app.js ./
COPY lib ./lib
COPY public ./public

# The Extension Manager bind-mounts this file so settings survive image updates.
RUN touch config.json

EXPOSE 8080

CMD ["node", "app.js"]
