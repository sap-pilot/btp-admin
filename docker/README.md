# BTP Admin — Docker Image

A Docker image for **BTP Admin** based on Node.js 24 (slim).  
The image is built from **locally compiled artifacts** — run `npm run build` first,
then `docker/build.sh` packages the output and pushes it to a registry.

## What's inside

| Component | Source |
|-----------|--------|
| Node.js 24 | `node:24-slim` (Debian Bookworm) |
| Server code | `server/dist/` — TypeScript compiled locally before `docker build` |
| React client | `server/public/` — Vite-built assets, compiled locally before `docker build` |
| Server deps | Installed by `npm ci --workspace=server --omit=dev` inside the image |
| Chromium | Downloaded by `playwright install --with-deps chromium` inside the image |
| OS libs | All Chromium system libraries (`libatk`, `libgbm`, `libnss3`, `libxkbcommon`, …) installed automatically by Playwright |
| SSH server | `openssh-server` — required for `cf ssh` access on Cloud Foundry |

---

## Prerequisites

- Node.js 20+ and npm (to build the app locally)
- Docker 24+
- A container registry account (Docker Hub, GitHub Container Registry, etc.)

---

## Build & publish

Two scripts cover the common workflows:

| Script | When to use |
|--------|-------------|
| `docker/build.sh` | Build the app **and** publish the image in one step |
| `docker/publish.sh` | Publish only — app already built (`npm run build` already ran) |

Both tag the image with the current **git commit SHA** (immutable) and as `:latest`,
then push both tags.

```bash
# Full build + publish (runs npm run build first)
./docker/build.sh

# Publish only — skips npm run build, uses existing server/dist + server/public
./docker/publish.sh

# Custom registry (works for both scripts)
REGISTRY=ghcr.io/myorg ./docker/publish.sh
```

Each script prints the exact SHA tag and the `cf push` command at the end.

**Why SHA tags?**  Cloud Foundry caches Docker image layers by tag name.  
If you push a new image under the same `:latest` tag and run `cf restage`, CF
reuses the cached droplet — it does **not** pull the new image.  
A unique SHA tag forces CF to treat every image as new, guaranteeing a fresh pull.

---

## Build manually (without the scripts)

```bash
# 1. Build the app locally
npm run build

# 2. Build and push the Docker image
SHA=$(git rev-parse --short HEAD)
docker build -f docker/Dockerfile \
  -t sapux/btp-admin:${SHA} \
  -t sapux/btp-admin:latest \
  .
docker push sapux/btp-admin:${SHA}
docker push sapux/btp-admin:latest
```

---

## Run locally

```bash
docker run --rm \
  -p 3000:3000 \
  -e PORT=3000 \
  -e CONFIG_JSON='{"services":[...]}' \
  -v "$(pwd)/response:/app/server/response" \
  sapux/btp-admin:latest
```

Open http://localhost:3000/overview

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP listen port (Cloud Foundry sets this automatically) |
| `CONFIG_JSON` | — | Full config as a JSON string (takes priority over `CONFIG_FILE`) |
| `CONFIG_FILE` | `./config.json` | Path to config file relative to `server/` working dir |
| `RESPONSE_DIR` | `./response` | Directory for response file storage |
| `SYNC_REMOTE` | — | Base URL of another BTP Status instance to sync history files from |
| `SYNC_INTERVAL` | `900` | Seconds between periodic remote sync runs |
| `LOG_LEVEL` | `debug` | Pino log level: `trace` `debug` `info` `warn` `error` |

---

## Deploy on SAP BTP Cloud Foundry (MTA)

### Quick update — new image, no MTA rebuild

After `./docker/build.sh` prints the SHA tag, push it directly to the running CF app:

```bash
cf push btp-admin --docker-image sapux/btp-admin:<sha>
```

CF pulls the image by its exact SHA tag so it cannot reuse a cached layer.  
This is the fastest way to deploy a code change.

> **Do not use `cf restage`** to pick up a new Docker image — CF restages from
> the existing droplet and ignores any new image pushed under the same tag.

### Full MTA deploy (first deploy or when `mta.yaml` changes)

Update the `docker.image` value in `mta.yaml` to the SHA tag, then deploy:

```yaml
modules:
  - name: btp-admin
    type: nodejs
    path: server
    parameters:
      docker:
        image: sapux/btp-admin:<sha>   # ← SHA tag from build.sh
      memory: 1G
      disk-quota: 4G
      enable-ssh: true
      keep-existing:
        env: true
    build-parameters:
      no-source: true
```

```bash
mbt build
cf deploy mta_archives/btp-admin_1.1.0.mtar -f --retries 1 \
  --strategy blue-green --skip-testing-phase
```

> **Why 1G memory?**  Playwright launches a full Chromium process per browser check.
> 256 MB is not enough; 1 GB comfortably handles concurrent checks.

### CF SSH

`enable-ssh: true` in `mta.yaml` enables `cf ssh btp-admin`.
The image includes `openssh-server` as required by the CF Docker SSH specification.

### PORT binding

Cloud Foundry injects `PORT` as an environment variable at runtime.
Express reads `process.env.PORT` — no manual configuration needed.

---

## Notes

- The Playwright-managed Chromium binary (not system Chrome) is bundled in the image.
  The `--no-sandbox` / `--disable-setuid-sandbox` flags are set in the application
  code so Chromium can run inside a container.
- Response files written to `RESPONSE_DIR` are ephemeral unless you mount a
  persistent volume or enable `SYNC_REMOTE`.
- The `server/dist/` and `server/public/` directories must exist locally before
  running `docker build`. Run `npm run build` (or `./docker/build.sh`) first.
