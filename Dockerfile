FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache dumb-init ca-certificates \
  && npm install -g npm@11.18.0 \
  && addgroup -S -g 10001 nodeapp \
  && adduser -S -u 10001 -G nodeapp -h /app nodeapp \
  && mkdir -p /app/logs \
  && chown -R nodeapp:nodeapp /app
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src
USER nodeapp
EXPOSE 3000
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/index.js"]
