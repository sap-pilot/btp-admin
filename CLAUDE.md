# CLAUDE.md

## Project Overview

Node.js full-stack application with a React frontend (shadcn/ui) and an Express backend serving as middleware/API layer. The Express server also serves the built React static assets directly (single deployable). Deployed to the **SAP BTP Cloud Foundry environment** as a **Multi-Target Application (MTA)**.

## Tech Stack

- **Frontend**: React + Vite, shadcn/ui (Radix UI + Tailwind CSS)
- **Backend**: Express (Node.js) — REST API / middleware + static host for the React build
- **Language**: TypeScript (frontend and backend)
- **Package manager**: npm
- **Deployment**: SAP BTP, Cloud Foundry environment — packaged as an MTA via `mta.yaml`

## Project Structure

```
.
├── client/                 # React + shadcn/ui frontend
│   ├── src/
│   │   ├── components/
│   │   │   └── ui/         # shadcn/ui components (generated — do not hand-edit)
│   │   ├── lib/
│   │   │   └── utils.ts    # cn() helper for class merging
│   │   ├── hooks/
│   │   ├── pages/
│   │   ├── App.tsx
│   │   └── main.tsx
│   ├── components.json     # shadcn/ui config
│   ├── tailwind.config.js
│   └── vite.config.ts
├── server/                 # Express backend (single nodejs module)
│   ├── src/
│   │   ├── routes/
│   │   ├── middleware/
│   │   ├── controllers/
│   │   ├── services/
│   │   ├── static.ts      # serves client build + SPA fallback
│   │   └── index.ts       # Express entry point
│   └── tsconfig.json
├── mta.yaml                # MTA development descriptor (edit manually)
├── package.json            # root (workspaces or scripts)
└── CLAUDE.md
```

The client build output is bundled into the `server` module at build time, and Express serves it (no separate UI module, no approuter, no HTML5 Application Repository).

## Commands

```bash
# Install (root + workspaces)
npm install

# Dev — run both concurrently
npm run dev

# Dev — individually
npm run dev:client       # Vite dev server (default :5173)
npm run dev:server       # Express w/ nodemon/tsx (default :3000)

# Build (app)
npm run build            # builds client, then server bundles client output
npm run build:client
npm run build:server

# Production (locally)
npm run start            # Express serves API + built React assets

# Lint / format / typecheck
npm run lint
npm run format
npm run typecheck

# Tests
npm test
npm test -- <path>       # single test file
```

## Dependency Policy (IMPORTANT)

**Keep runtime dependencies to an absolute minimum. Prefer native Node.js and platform features over libraries.**

- Before adding any dependency, check whether the standard library already covers it. Default to **no** new dependency.
- Use native Node.js APIs instead of packages, e.g.:
  - `fetch` (global, built-in) instead of `axios` / `node-fetch`
  - `node:crypto` instead of `uuid`, hashing, or token libraries
  - `node:test` + `node:assert` instead of heavyweight test runners where practical
  - `node:fs/promises`, `node:path`, `node:url`, `node:util` instead of helper libs
  - `URL` / `URLSearchParams`, `structuredClone`, `AbortController` — all global
  - native `Intl` for formatting instead of date/number libraries
- Prefer small, focused, well-maintained packages over large frameworks when a dependency is genuinely required.
- Every new dependency must be justified in the PR (why native APIs are insufficient). Avoid transitive-heavy packages.
- Do not add a utility library (e.g. lodash) for a few helpers — write the small helper or use native methods.
- Keep `devDependencies` lean too; avoid overlapping tools.

## SAP BTP / MTA Deployment

Built with the **Cloud MTA Build Tool (MBT)** and deployed with the **Cloud Foundry CLI** + **MultiApps (mta) plugin**.

```bash
# Prerequisites (once)
npm install -g mbt                     # Cloud MTA Build Tool
cf install-plugin multiapps            # CF MTA plugin

# Build the MTA archive → ./mta_archives/<project>_<version>.mtar
mbt build

# Log in to the target subaccount / space
cf login -a <api-endpoint>             # e.g. https://api.cf.eu10.hana.ondemand.com
cf target -o <org> -s <space>          # requires Space Developer role

# Deploy
cf deploy mta_archives/<project>_<version>.mtar

# Operations
cf mtas                                # list deployed MTAs
cf mta <mta-id>                        # show modules/services of one MTA
cf undeploy <mta-id> --delete-services # tear down
```

### MTA Conventions

- `mta.yaml` is the **development descriptor** and is edited **manually**. The `mtad.yaml` deployment descriptor is **generated at build time** by MBT — do not hand-edit or commit it.
- This app is a **single deployable module**: one `type: nodejs` Express module that serves both the API and the React build. No approuter module, no `html5` module, no `xs-app.json`.
- Pin `buildpack: nodejs_buildpack` and set sensible `memory` / `disk-quota`.
- The client must be built **before** the server is packaged, so its static output is included in the module path. Wire this via build parameters (or a root `npm run build` invoked by the npm builder).
- Backing services (XSUAA, destinations, etc.) are **resources** wired via `requires` only if/when actually needed — keep them out until required.
- Keep `version` in `mta.yaml` in sync with releases; the version is baked into the `.mtar` filename.
- Use an **MTA extension descriptor** (`*.mtaext`) for environment-specific values (dev/test/prod) instead of editing `mta.yaml` per environment.

### Indicative `mta.yaml` shape

```yaml
_schema-version: "3.3"
ID: my-app
version: 0.0.1

modules:
  - name: my-app-srv
    type: nodejs
    path: server
    parameters:
      memory: 256M
      disk-quota: 512M
      buildpack: nodejs_buildpack
    build-parameters:
      builder: custom
      commands:
        - npm ci
        - npm run build        # builds client + server, bundles client into server
      # the packaged module must contain the built server AND the client build output

resources: []
```

> Treat the snippet above as a template — adjust names, build commands, and add `resources` / `requires` only when a real service (e.g. XSUAA) is introduced.

## shadcn/ui Conventions

- Add components via CLI, never create by hand:
  ```bash
  cd client && npx shadcn@latest add button dialog form
  ```
- Generated components live in `client/src/components/ui/` — treat as vendored; avoid editing directly. Wrap or compose them in your own components instead.
- Use the `cn()` util from `lib/utils.ts` for conditional class names; don't concatenate strings manually.
- Styling is Tailwind-only. Use design tokens / CSS variables defined in the Tailwind theme rather than hardcoded colors.
- Check `components.json` for path aliases (`@/components`, `@/lib`) before importing.

## Express Conventions

- Keep `index.ts` thin: app setup, middleware registration, route mounting, static serving, error handler, listen.
- Route → controller → service layering. Routes only wire HTTP; business logic lives in services.
- Centralized error handling via a final `(err, req, res, next)` middleware; controllers use `next(err)` rather than ad-hoc `res.status().json()` for errors.
- Validate request input at the boundary before it reaches controllers (prefer a minimal validator or hand-written guards over a heavy schema library — see Dependency Policy).
- All env access goes through a single validated config module — no `process.env.X` scattered across files.
- Bind to `process.env.PORT` (Cloud Foundry assigns the port at runtime) — never hardcode it.
- Serve the React build with `express.static` and add a **SPA fallback** so client-side routes resolve to `index.html`:
  - Mount API routes under `/api` **first**.
  - Then `express.static(clientBuildDir)`.
  - Then a catch-all GET that returns `index.html` for non-`/api` paths.
- Use `node:path` to resolve the client build directory relative to the server entry point.

## API & Routing

- Frontend calls the API under `/api/*`.
- In dev, Vite proxies `/api` to the Express server (see `vite.config.ts` `server.proxy`) to avoid CORS.
- In production (and on BTP), Express is the single ingress: it serves the React build and handles `/api/*` in the same process. No CORS needed (same origin).

## Conventions

- TypeScript strict mode on; no `any` without justification.
- Shared types between client and server go in a `shared/` or `types/` location — keep request/response contracts in sync.
- Imports use path aliases, not deep relative paths.
- Keep components small and presentational; data fetching in hooks/pages.

## Do Not

- Do not add dependencies that native Node.js / browser APIs already cover (see Dependency Policy).
- Do not hand-edit files in `client/src/components/ui/`.
- Do not hand-edit or commit the generated `mtad.yaml` or the `mta_archives/` output.
- Do not introduce an approuter, HTML5 repo module, or `xs-app.json` — Express serves the UI directly.
- Do not commit `.env` files, secrets, or service keys.
- Do not hardcode the listen port; use `process.env.PORT`.
- Do not put business logic in Express route handlers.
- Do not add CSS frameworks or component libraries that conflict with Tailwind/shadcn.
- Do not bypass the config module to read env vars directly.
- Do not run git commit unless I explicitly tell you to do so in the chat.