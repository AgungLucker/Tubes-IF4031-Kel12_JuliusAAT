FROM node:22 AS base
WORKDIR /usr/local/app

FROM base AS pvmbg-mock
COPY package.json package-lock.json ./
RUN npm ci

COPY src ./src
EXPOSE 8082
CMD ["node", "src/server.js"]