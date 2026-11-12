# syntax=docker/dockerfile:1.7
#
# Two runnable targets built from the same code:
#   docker build --target api    -t scraper-api .      (light, no browsers)
#   docker build --target worker -t scraper-worker .   (includes Playwright Chromium)

# Runtime images use Node 20. pnpm 11 itself needs a newer Node, so only the
# install/build stages use BUILD_IMAGE (output is plain JS + node_modules).
ARG NODE_IMAGE=node:20-bookworm-slim
ARG BUILD_IMAGE=node:22-bookworm-slim

# ---------------------------------------------------------------- base
FROM ${BUILD_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN corepack enable && corepack prepare pnpm@11.1.3 --activate
WORKDIR /app

# ---------------------------------------------------------------- build
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

# ---------------------------------------------------------------- prod deps
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod

# ---------------------------------------------------------------- api
FROM ${NODE_IMAGE} AS api
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/api/main.js"]

# ---------------------------------------------------------------- worker
FROM ${NODE_IMAGE} AS worker
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Chromium + its OS libraries (needs root), then drop privileges.
RUN node node_modules/playwright/cli.js install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* \
    && chmod -R a+rX /ms-playwright
USER node
HEALTHCHECK --interval=20s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "dist/worker/healthcheck.js"]
CMD ["node", "dist/worker/main.js"]
