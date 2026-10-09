FROM node:22 AS base
WORKDIR /usr/local/app

FROM base AS aggregator
COPY package.json package-lock.json ./
RUN npm ci

COPY src ./src
EXPOSE 8090

HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8090)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
