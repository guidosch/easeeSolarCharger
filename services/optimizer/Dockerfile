# Cloud Run image for @app/optimizer.
#
# The service is bundled with esbuild into a single file, so the runtime image needs exactly one
# dependency: firebase-admin, which is left external because its gRPC and protobuf loading does not
# survive bundling. Everything else — Hono, Zod, and the workspace packages — is in the bundle.
FROM node:22-slim AS build
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.21.0 --activate

# The lockfile and every manifest first, so a source-only change reuses the install layer.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/core/package.json packages/core/
COPY packages/shared/package.json packages/shared/
COPY packages/adapters/package.json packages/adapters/
COPY services/api/package.json services/api/
COPY services/optimizer/package.json services/optimizer/
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY tsconfig.base.json ./
COPY packages/ packages/
COPY services/ services/
RUN pnpm --filter @app/optimizer build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Pinned to the version the lockfile resolves, so the image is reproducible from this file.
RUN npm install --omit=dev --no-package-lock --no-audit --no-fund firebase-admin@13.10.0

# `.mjs`, because the package.json npm writes above has no `"type": "module"`: as `.js` the bundle
# only loads via Node's fallback reparse, which warns on every cold start.
COPY --from=build /app/services/optimizer/dist/index.js ./index.mjs

# Cloud Run sets PORT; the service reads its own variable, so map it at start.
ENV NODE_OPTIONS=--enable-source-maps
CMD ["node", "index.mjs"]
