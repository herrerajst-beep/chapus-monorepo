# ==========================================
# ETAPA 1: Builder (Aislado de React Native)
# ==========================================
FROM node:20-alpine AS builder
WORKDIR /app

# Herramientas de compilación por si algún paquete de terceros requiere node-gyp
RUN apk add --no-cache python3 make g++

# 1. Copiar manifiestos raíz y exclusivamente los paquetes necesarios para el backend
COPY package.json package-lock.json tsconfig*.json ./
COPY packages/core ./packages/core
COPY packages/api-contract ./packages/api-contract
COPY packages/backend ./packages/backend

# 2. Instalar dependencias SOLO para el grafo del backend (ignora apps/* y packages/ui)
RUN npm ci -w @chapus/backend -w @chapus/core -w @chapus/api-contract --include-workspace-root

# 3. Empaquetar @chapus/backend (tsup absorbe @chapus/core y @chapus/api-contract en dist/main.js)
RUN npm run build -w @chapus/backend

# 4. Eliminar devDependencies dejando solo las librerías de runtime del backend
RUN npm prune --omit=dev -w @chapus/backend -w @chapus/core -w @chapus/api-contract --include-workspace-root

# ==========================================
# ETAPA 2: Runner Minimalista (Producción / Staging)
# ==========================================
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=staging
ENV PORT=4000

# Crear grupo chapus (1001) y usuario argon perteneciente explícitamente a ese grupo (-G chapus)
RUN addgroup -g 1001 -S chapus && \
    adduser -u 1001 -S argon -G chapus

# Copiar únicamente node_modules de producción y el bundle compilado dist/main.js
COPY --from=builder --chown=argon:chapus /app/package.json ./package.json
COPY --from=builder --chown=argon:chapus /app/node_modules ./node_modules
COPY --from=builder --chown=argon:chapus /app/packages/backend/dist/main.js ./dist/main.js
COPY --from=builder --chown=argon:chapus /app/packages/backend/dist/main.js.map ./dist/main.js.map

USER argon

EXPOSE 4000

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:4000/v1/health || exit 1

CMD ["node", "dist/main.js"]
