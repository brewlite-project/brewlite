FROM node:26-bookworm-slim AS build

WORKDIR /app

# argon2 has a native addon. Keep its fallback toolchain in this stage only.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
COPY prisma7.config.ts tsconfig.json tsconfig.build.json nest-cli.json ./
# The .dockerignore excludes any client generated on the Windows host.
COPY src ./src

# Prisma config requires a URL to parse; generate is offline and does not connect.
RUN DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build_placeholder?schema=public" npm run db:generate
RUN npm run build

# This target intentionally retains Prisma CLI, config, schema, and migrations
# for the one-shot Docker Compose migration service.
FROM build AS migrate

# Runtime dependencies are pruned in a separate stage so the migration target
# retains the Prisma CLI.
FROM build AS production-deps
# Remove Prisma CLI, Nest CLI, TypeScript and other dev dependencies before copy.
# npm keeps Prisma CLI as @prisma/client's optional peer, so remove it explicitly.
RUN npm prune --omit=dev --omit=peer \
    && rm -rf node_modules/prisma \
    && find dist -type f \( -name '*.d.ts' -o -name '*.js.map' -o -name '*.tsbuildinfo' \) -delete

FROM node:26-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

# Runtime shared libraries for Prisma's Linux client and argon2's native addon.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libgcc-s1 libstdc++6 libssl3 zlib1g \
    && rm -rf /var/lib/apt/lists/*

COPY --from=production-deps --chown=node:node /app/package.json ./package.json
COPY --from=production-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=production-deps --chown=node:node /app/dist ./dist

USER node
EXPOSE 3001
CMD ["node", "dist/main.js"]
