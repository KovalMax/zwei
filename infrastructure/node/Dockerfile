FROM node:22-bookworm-slim

ARG UID=1000
ARG GID=1000
ARG NODE_USER_NAME=node

RUN mkdir -p /app/node_modules && chown -R $UID:$GID /app

WORKDIR /app

RUN groupmod -og $GID $NODE_USER_NAME \
  && usermod -u $UID -g $GID $NODE_USER_NAME

COPY package*.json ./

RUN npm i

COPY --chown=$UID:$GID . .

USER $NODE_USER_NAME

EXPOSE 4200

CMD npm run start
