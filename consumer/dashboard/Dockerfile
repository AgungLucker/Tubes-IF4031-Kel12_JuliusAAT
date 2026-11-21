FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY index.js metrics.js tracing.cjs ./ 
USER node
CMD ["node", "--require", "./tracing.cjs", "index.js"] 