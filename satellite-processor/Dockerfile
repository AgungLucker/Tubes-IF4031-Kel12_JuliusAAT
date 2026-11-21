FROM node:22-alpine AS base
WORKDIR /usr/local/app

FROM base AS satellite-processor
COPY package.json package-lock.json ./
RUN npm ci

COPY src ./src
EXPOSE 8083

HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8083)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--require", "./src/tracing.cjs", "src/server.js"]   
