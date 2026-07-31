FROM node:24-slim

# openssh-server — required for `cf ssh` on Cloud Foundry Docker deployments
# ca-certificates — needed for outbound HTTPS calls at runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssh-server \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# CF SSH: sshd expects this directory at runtime
RUN mkdir -p /var/run/sshd

WORKDIR /app

# Package manifests — separate layer so npm ci is cached when only source changes
COPY package.json package-lock.json ./
COPY server/package.json ./server/

# Pre-built artifacts produced by `npm run build` locally:
#   server/dist/   — compiled TypeScript (ESM)
#   server/public/ — Vite-built React client assets
COPY server/dist/ ./server/dist/
COPY server/public/ ./server/public/

# Install server production dependencies only (playwright is a prod dep)
RUN npm ci --workspace=server --omit=dev

# Download Playwright-managed Chromium binary and every OS-level library it
# needs (libatk, libgbm, libnss3, libxkbcommon, etc.) in one step
RUN npx playwright install --with-deps chromium

# Cloud Foundry sets PORT dynamically; Express reads process.env.PORT.
# EXPOSE is documentation only — CF ignores it and uses its own routing.
EXPOSE 3000

WORKDIR /app/server
CMD ["node", "dist/index.js"]
