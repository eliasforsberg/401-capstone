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

## Environment Variables

### Overview

The project uses three environments that share the same schema and codebase but point at different Supabase projects and Square credential tiers.

| Environment | Supabase Project | Square tier | When used |
|---|---|---|---|
| **Local dev** | `supabase start` (Docker) | Sandbox | Day-to-day development |
| **Staging** | Dedicated cloud project | Sandbox | Pre-production QA, PR previews |
| **Production** | Dedicated cloud project | Production | Live |

### Setting up local development

Copy the example files and fill in your local values (printed by `supabase start`):

```bash
cp .env.example .env.local
cp mobile/.env.example mobile/.env.local
```

### Environment variable matrix

The table below lists every variable, where it is required, and how to obtain the value.

| Variable | Local dev | Staging | Production | Notes |
|---|---|---|---|---|
| `EXPO_PUBLIC_SUPABASE_URL` | `http://127.0.0.1:54321` | Cloud project URL | Cloud project URL | Mobile client only. Printed by `supabase start` or in Supabase dashboard → Settings → API |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | Local anon key | Cloud anon key | Cloud anon key | Mobile client only. Safe to expose — restricted by RLS |
| `EXPO_PUBLIC_PUSH_NOTIFICATIONS_ENABLED` | `false` | `false` | `false` | Phase 2 flag — leave `false` for MVP |
| `SUPABASE_URL` | `http://127.0.0.1:54321` | Cloud project URL | Cloud project URL | CI / scripts only |
| `SUPABASE_ANON_KEY` | Local anon key | Cloud anon key | Cloud anon key | CI / scripts only |
| `SUPABASE_SERVICE_ROLE_KEY` | Local service role key | Cloud service role key | Cloud service role key | **Never expose to mobile client.** CI / Edge Functions only |
| `SUPABASE_PROJECT_REF` | N/A (local Docker) | `<staging-project-ref>` | `<production-project-ref>` | Needed for `supabase db push --project-ref` |
| `SQUARE_ACCESS_TOKEN` | Sandbox token | Sandbox token | Production token | Edge Function env secret (Supabase Vault) |
| `SQUARE_WEBHOOK_SIGNATURE_KEY` | Sandbox key | Sandbox key | Production key | Edge Function env secret (Supabase Vault) |
| `SQUARE_APPLICATION_ID` | Sandbox app ID | Sandbox app ID | Production app ID | Edge Function env secret (Supabase Vault) |
| `SQUARE_ENVIRONMENT` | `sandbox` | `sandbox` | `production` | Edge Function env secret |

> **Square credentials** are never stored in GitHub Secrets or the mobile bundle. They are stored as [Supabase Vault secrets](https://supabase.com/docs/guides/database/vault) on the relevant project and injected into Edge Functions at runtime.

### GitHub Actions secrets required

Configure these in **Settings → Secrets and variables → Actions** for your repository:

| Secret name | Required by | Description |
|---|---|---|
| `SUPABASE_ACCESS_TOKEN` | `deploy-staging.yml`, `deploy-production.yml` | Personal access token from [app.supabase.com](https://app.supabase.com) → Settings → Access Tokens |
| `STAGING_SUPABASE_PROJECT_REF` | `deploy-staging.yml` | Project ref of your staging Supabase project |
| `PROD_SUPABASE_PROJECT_REF` | `deploy-production.yml` | Project ref of your production Supabase project |

---

## Staging Environment Setup

Follow these steps to create and configure a dedicated staging Supabase project.

### 1 — Create the Supabase project

1. Go to [app.supabase.com](https://app.supabase.com) → New Project.
2. Name it (e.g. `ai-inventory-staging`) and choose a region.
3. Save the **Project URL**, **anon key**, and **service role key** — you will need them below.
4. Copy the **Project Reference ID** (shown in Settings → General).

### 2 — Apply migrations

```bash
# Link your local CLI to the staging project (one-time)
supabase link --project-ref <staging-project-ref>

# Push all migrations
supabase db push --project-ref <staging-project-ref>
```

Or let the CI pipeline handle it automatically on every push to `main` (see [`.github/workflows/deploy-staging.yml`](.github/workflows/deploy-staging.yml)).

### 3 — Configure Square sandbox credentials in Supabase Vault

Run these commands via the Supabase CLI or in the SQL editor on the staging project:

```sql
-- Store Square sandbox credentials as Vault secrets
SELECT vault.create_secret('<sandbox-access-token>',    'SQUARE_ACCESS_TOKEN');
SELECT vault.create_secret('<sandbox-webhook-key>',     'SQUARE_WEBHOOK_SIGNATURE_KEY');
SELECT vault.create_secret('<sandbox-application-id>',  'SQUARE_APPLICATION_ID');
SELECT vault.create_secret('sandbox',                   'SQUARE_ENVIRONMENT');
```

Alternatively, set them as Edge Function environment variables in the Supabase dashboard → Edge Functions → `<function-name>` → Configuration.

### 4 — Configure Square sandbox webhook

1. In the [Square Developer Dashboard](https://developer.squareup.com), open your sandbox app → Webhooks.
2. Add a new webhook endpoint pointing to your staging Edge Function URL:
   `https://<staging-project-ref>.supabase.co/functions/v1/square-webhook`
3. Subscribe to events: `payment.completed`, `refund.created`, `order.cancelled`.
4. Copy the generated **Signature Key** and store it as the `SQUARE_WEBHOOK_SIGNATURE_KEY` Vault secret (step 3 above).

### 5 — Add environment variables to GitHub Actions

In your repository → **Settings → Secrets and variables → Actions**, add:
- `SUPABASE_ACCESS_TOKEN`
- `STAGING_SUPABASE_PROJECT_REF`

---

## CI/CD Pipeline

| Workflow | Trigger | Actions |
|---|---|---|
| [`ci.yml`](.github/workflows/ci.yml) | Push / PR to `main` | Install → type-check → lint → unit tests |
| [`deploy-staging.yml`](.github/workflows/deploy-staging.yml) | Push to `main` (after CI) | Tests → `supabase db push` → `supabase functions deploy` → staging |
| [`deploy-production.yml`](.github/workflows/deploy-production.yml) | Tag `v*.*.*` | Tests → `supabase db push` → `supabase functions deploy` → production |

**Environment promotion flow**: `local dev → staging → production`. No direct production deployments — all production changes must go through staging first.

---

## Branch Protection

The `main` branch requires CI to pass before merging. See `.github/workflows/ci.yml` for the pipeline definition.
