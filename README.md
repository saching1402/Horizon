# Horizon — Frontier Technology Deal Flow

Institutional deal-flow management for early- and growth-stage **frontier
technology** companies — Frontier AI models, agentic AI, AI infra, the
semiconductor value chain, quantum, robotics, drug discovery, defense tech,
compute marketplaces, energy-for-compute, space, biotech and more (22 segments).

Horizon runs **daily discovery agents** that surface promising companies across
every segment, refresh company trajectories, listen for hyperscaler / NVIDIA /
pharma signals, re-score the pipeline, and email a daily synopsis.

Everything is persisted in **PostgreSQL** behind a small Express API; the
frontend loads entirely from that API.

## The 5-stage funnel

| Stage | Short name | Meaning |
| --- | --- | --- |
| 1 | **Web-Flagged** | Flagged through web analysis |
| 2 | **VC-Backed** | Invested by marquee early-stage managers |
| 3 | **Leader-Quoted** | Quoted by hyperscalers / NVIDIA / accelerators / pharma leaders |
| 4 | **My Flag** | Personally flagged or added |
| 5 | **Shortlist** | Final key shortlist |

## What's inside

- **Dashboard** — funnel, valuation×growth landscape, top-by-score, segment map,
  leader coverage, growth distribution, and the latest daily briefing.
- **Deal Funnel** — 5-stage pipeline board.
- **Companies** — sortable table + per-company drawer: revenue/valuation
  trajectory, 6-factor score radar, investor base, announcements. Add companies,
  personally flag to Stage 4.
- **Segments** — 22 frontier segments with daily market intel.
- **Investors** — tiered funds (AUM, HQ, partners, focus, media, pipeline
  overlap) driving the investor-quality score. Add funds & set tiers.
- **Research & Sources** — trusted-source grounding + add documents/links.
- **Daily Agents** — run on demand or on a daily cron; view the digest.
- **Settings** — manage email recipients, cadence, scoring weights & tier
  multipliers (all persisted, and they re-score the pipeline live).

## Scoring methodology

Horizon score (0–100) = weighted blend of revenue/ARR growth, investor-base
quality (tier-weighted), big-tech interest & coverage, valuation attractiveness,
segment/industry growth, and momentum. Weights and tier multipliers are editable
in Settings and applied server-side (`scoring.js`).

## Architecture

```
server.js     Express API + serves the frontend + boots the agent scheduler
db.js         PostgreSQL pool, schema, migration & seed (segments/investors/companies/…)
scoring.js    Deterministic weighted Horizon-score engine
agents.js     Daily agents (discovery/trajectory/digest) + node-cron + email
public/       Frontend (index.html) — loads everything from /api
```

### API (selected)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Health check (used by Railway) |
| GET | `/api/bootstrap` | Everything the dashboard needs in one call |
| GET/POST/PATCH/DELETE | `/api/companies[/:id]` | Companies + trajectory + announcements |
| GET/POST/DELETE | `/api/investors[/:id]` | Tiered investors |
| GET/POST/DELETE | `/api/recipients[/:id]` | Digest email recipients |
| GET/PUT | `/api/config` | Scoring weights, tier multipliers, cadence |
| POST | `/api/agents/run` | Run the daily agents now |
| GET | `/api/agents/runs` | Recent agent runs |

## Daily agents & email

The daily job (default **05:30**, configurable in Settings) refreshes
trajectories, recomputes scores, composes a digest and emails it to all active
recipients.

- **Agent intelligence** is optional: set `ANTHROPIC_API_KEY` (or
  `OPENAI_API_KEY`) to enable live web-research discovery. Without a key,
  trajectory/scoring/digest still run.
- **Email** is optional: set the `SMTP_*` vars to send. Without them, the digest
  is generated and stored (visible in-app) but not emailed.

Run the agents manually any time from the **Daily Agents** tab, or:

```bash
npm run agents:run
```

## Deploy to Railway

1. **Push this repo to GitHub** (done).
2. Railway → **New Project → Deploy from GitHub repo** → pick `horizon`.
   Railway auto-detects Node via Nixpacks and runs `npm start` (`railway.json`).
3. In the project, **New → Database → Add PostgreSQL**.
4. Open the **app service → Variables** and add:
   ```
   DATABASE_URL = ${{Postgres.DATABASE_URL}}
   OWNER_EMAIL  = sachinganeshan14@gmail.com
   ```
   (Optionally add `ANTHROPIC_API_KEY` and the `SMTP_*` vars to light up live
   discovery and email.)
5. Redeploy if needed. On first boot the app creates its tables and seeds the
   segments, investors and sample companies. The health check at `/api/health`
   should go green.
6. **Settings → Networking → Generate Domain** for a public URL.

## Run locally

```bash
npm install
cp .env.example .env      # point DATABASE_URL at a local Postgres
npm start                 # http://localhost:3000
```

The schema and seed data are created automatically on first run.
