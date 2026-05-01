FROM oven/bun:1-alpine

WORKDIR /app

RUN apk add --no-cache unzip

COPY server/package.json server/tsconfig.json ./
RUN bun install --no-save 2>/dev/null || true

COPY server/ ./

ENV MULTIWEB_HOSTNAME=0.0.0.0 \
    MULTIWEB_SITES_DIR=/var/www/sites

EXPOSE 3000

CMD ["bun", "run", "src/index.ts"]
