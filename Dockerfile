# syntax=docker/dockerfile:1.7
############################################################
# Multi-stage Dockerfile with dependency caching
# - `deps`    caches the dependency install (invalidated only when
#             package*.json changes) behind a BuildKit cache mount
# - `builder` compiles the app against that layer, then prunes dev deps
# - `runner`  keeps only production node_modules + dist and drops root
############################################################

ARG NODE_VERSION=20

############################################################
# Stage 1 — deps: resolve every dependency exactly once
############################################################
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app

# Copy only the manifests first so this layer is reused while source edits.
COPY package.json package-lock.json ./

# The npm cache lives in a BuildKit cache mount instead of an image layer, so
# it is reused across builds without adding its size to the image.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund

############################################################
# Stage 2 — builder: compile, then strip devDependencies
############################################################
FROM node:${NODE_VERSION}-alpine AS builder
WORKDIR /app

# Reuse the resolved deps instead of reinstalling when only source changed.
COPY --from=deps /app/node_modules ./node_modules

COPY . .
RUN npm run build \
 && npm prune --omit=dev --no-audit --no-fund

############################################################
# Stage 3 — runner: dist + production node_modules, non-root
############################################################
FROM node:${NODE_VERSION}-alpine AS runner
LABEL org.opencontainers.image.description="Trellis backend runtime"

WORKDIR /app

# NODE_ENV must be re-declared inside the stage that consumes it; an ARG from
# the top of the file is only in scope for FROM lines, so the previous
# `ENV NODE_ENV=${NODE_ENV}` expanded to an empty string here.
ARG NODE_ENV=production
ENV NODE_ENV=${NODE_ENV}

# tiny init to forward signals and reap orphaned processes
RUN apk add --no-cache dumb-init

# Dedicated unprivileged system user/group. UID/GID 1001 is pinned so bind
# mounts and volume ownership stay stable across rebuilds (node's own uid is
# 1000).
RUN addgroup -S -g 1001 nodejs \
 && adduser -S -u 1001 -G nodejs nestjs

# Copy only what the runtime needs, owned by the non-root user.
COPY --from=builder --chown=nestjs:nodejs /app/dist ./dist
COPY --from=builder --chown=nestjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nestjs:nodejs /app/modules ./modules
COPY --from=builder --chown=nestjs:nodejs /app/package.json ./package.json

# Writable scratch directory for the unprivileged process.
RUN mkdir -p /app/tmp && chown -R nestjs:nodejs /app/tmp

ENV PORT=3000

EXPOSE 3000

# Probe the app's liveness route. The bare /api/v1/health prefix used previously
# is not registered by the health controller at all, so the container was
# permanently unhealthy. The documented path (docs/kubernetes-health-probes.md,
# the k8s manifest and docker-compose) is /api/v1/health/live, while the current
# global prefix "api/v1" combined with URI versioning actually registers
# /api/v1/v1/health/live; accept either so the probe reflects process liveness
# without depending on that inconsistency.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "const http=require('http');const port=process.env.PORT||3000;const paths=['/api/v1/health/live','/api/v1/v1/health/live'];const probe=i=>{if(i>=paths.length)process.exit(1);const r=http.get({host:'127.0.0.1',port,path:paths[i]},res=>{res.resume();if(res.statusCode===200)process.exit(0);probe(i+1)});r.on('error',()=>probe(i+1))};probe(0)"

USER nestjs
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main"]
