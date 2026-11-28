FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=8080 HOST=0.0.0.0
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- "http://127.0.0.1:${PORT}$(node -e 'const u=new URL(process.env.PUBLIC_URL);process.stdout.write(u.pathname==="/"?"":u.pathname)')/healthz" >/dev/null || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/index.js"]
