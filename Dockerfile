FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
ENV NPM_CONFIG_AUDIT=false
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci --no-audit
COPY . .
RUN npm run db:generate && npm run build:contracts && npm run build -w @todo/api

FROM build AS api
ENV NODE_ENV=production
EXPOSE 3101
CMD ["sh", "-c", "npm run db:migrate && npm run db:seed && npm run start -w @todo/api"]

FROM build AS web
ARG NEXT_PUBLIC_API_URL=http://localhost:3101
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN npm run build -w @todo/web
ENV NODE_ENV=production
EXPOSE 3100
CMD ["npm", "run", "start", "-w", "@todo/web"]
