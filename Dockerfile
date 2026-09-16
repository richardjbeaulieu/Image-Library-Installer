# Image Library web server, for running on the NAS.
FROM node:24-slim

ENV NODE_ENV=production \
    PORT=8787 \
    LIBRARY_ROOT=/library \
    DATA_DIR=/data

WORKDIR /app

COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src/lib ./src/lib
COPY src/renderer ./src/renderer
COPY server/*.js ./server/
COPY web ./web

EXPOSE 8787
VOLUME ["/data"]

HEALTHCHECK --interval=60s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
