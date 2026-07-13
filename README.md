# AI Inventory Manager — 401 Capstone

A mobile-first inventory and purchasing platform for micro retail businesses. Built with React Native (Expo) + Supabase.

---

## Local Development

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (running)
- [Supabase CLI](https://supabase.com/docs/guides/cli) v1.x or later (`brew install supabase/tap/supabase`)
- Node.js 20.18.0 — use `nvm use` (`.nvmrc` and `.node-version` pin the version)
- [Expo Go](https://expo.dev/go) app on your iOS/Android device for development

### Mobile app setup

```bash
# Install dependencies
cd mobile && npm install

# Start Expo dev server
npm run start   # or: npm run ios / npm run android
```

Alternatively, from the repo root you can run `npm run start` (routes to the mobile workspace).

### Start the local Supabase stack

```bash
supabase start
```

### Stop the local Supabase stack

```bash
supabase stop
```

### Local stack URLs

| Service | URL |
|---|---|
| **Supabase Studio** (database GUI) | http://127.0.0.1:54323 |
| **REST API** (PostgREST) | http://127.0.0.1:54321 |
| **GraphQL API** | http://127.0.0.1:54321/graphql/v1 |
| **Auth** | http://127.0.0.1:54321/auth/v1 |
| **Storage** | http://127.0.0.1:54321/storage/v1 |
| **Realtime** | ws://127.0.0.1:54321/realtime/v1 |
| **Database (Postgres)** | `postgresql://postgres:postgres@127.0.0.1:54322/postgres` |
| **Inbucket** (email testing) | http://127.0.0.1:54324 |
| **Edge Functions** | http://127.0.0.1:54321/functions/v1 |

> **anon key** and **service_role key** are printed by `supabase start` and also available via `supabase status`.

### Apply migrations

```bash
supabase db push
```

### Reset the database (apply migrations + seed data)

```bash
supabase db reset
```

---

## Project Structure

```
401-capstone/
├── .nvmrc               # Pinned Node.js version (20.18.0)
├── .node-version        # Same pin for tools that read this file
├── package.json         # Root workspace (npm workspaces)
├── mobile/              # Expo React Native app
│   ├── src/
│   │   └── app/         # Expo Router file-based routes
│   ├── app.json         # Expo config
│   ├── tsconfig.json    # Strict TypeScript + @/ path alias → src/
│   └── babel.config.js  # Babel preset-expo + module-resolver
└── supabase/
    ├── config.toml      # Local dev stack configuration
    ├── migrations/      # Ordered SQL migration files
    ├── functions/       # Supabase Edge Functions
    └── seed.sql         # Development seed data (added in task 7.1)
```

---

## Branch Protection

The `main` branch requires CI to pass before merging. See `.github/workflows/ci.yml` (added in task 1.2) for the pipeline definition.
