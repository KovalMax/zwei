FROM node:24-bookworm-slim

ENV CHROME_BIN=/usr/local/bin/chromium-no-sandbox

ARG UID=1000
ARG GID=1000
ARG NODE_USER_NAME=node

RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium \
  && rm -rf /var/lib/apt/lists/* \
  && printf '%s\n' '#!/bin/sh' 'exec /usr/bin/chromium --no-sandbox "$@"' > /usr/local/bin/chromium-no-sandbox \
  && chmod 755 /usr/local/bin/chromium-no-sandbox \
  && mkdir -p /app/node_modules \
  && chown -R $UID:$GID /app

WORKDIR /app

RUN groupmod -og $GID $NODE_USER_NAME \
  && usermod -u $UID -g $GID $NODE_USER_NAME

COPY package*.json ./

RUN npm i

COPY --chown=$UID:$GID . .

USER $NODE_USER_NAME

EXPOSE 4200

CMD npm run start
