FROM node:22 AS base
WORKDIR /usr/local/app

FROM base AS bmkg-mock
COPY package.json package-lock.json ./
RUN npm ci

COPY src ./src
EXPOSE 8081
CMD ["node", "src/server.js"]