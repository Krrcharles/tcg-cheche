# TCG Cheche

Discord TCG built around a shared card catalogue, daily boosters, collections, and direct card-for-card trading.

## Project status

Product/domain design v0 is documented. The TypeScript bootstrap connects to Discord and supports graceful shutdown; gameplay commands are not implemented yet.

## Architecture v0

- TypeScript + discord.js modular monolith
- PostgreSQL for persistent game state
- Drizzle ORM
- RustFS as an S3-compatible object store for card assets
- Docker Compose deployment on a small OVH VPS
- No Redis, currency system, marketplace, spawn system, public HTTP API, reverse proxy, or domain name in the initial architecture
- Development and production run the same application image with separate Discord bot tokens and separate PostgreSQL databases
- Development and production share the same S3 bucket because card assets belong to the global catalogue
- One application instance serves one configured Discord guild in v0
- Gameplay/balancing configuration lives in versioned `config/game.yaml`

## Documentation

- [`docs/domain.md`](docs/domain.md) — accepted gameplay and Discord UX rules
- [`docs/architecture.md`](docs/architecture.md) — runtime and software architecture
- [`docs/data-model.md`](docs/data-model.md) — PostgreSQL-oriented persistence model and transaction requirements
- [`docs/repository-structure.md`](docs/repository-structure.md) — intended source layout
- [`docs/decisions/`](docs/decisions/) — architecture decision records
- [`AGENTS.md`](AGENTS.md) — implementation guidance for Codex/agents

## Implementation

Work should be implemented issue by issue from the GitHub backlog. Start with issue #1 and preserve the architectural/domain constraints in the documentation.

## Local development

Use Node.js 24 LTS and its bundled npm.

1. Run `npm install` (or `npm ci` for a reproducible lockfile install).
2. Copy `.env.example` to `.env` and set your Discord token/guild ID, database URL, and S3 endpoint, credentials, and bucket.
3. Run `npm run dev`. Stop with Ctrl+C; SIGTERM is also supported for process managers.

The bootstrap validates the environment and reads `config/game.yaml` once before connecting to Discord. Run launch commands from the repository root so the game file can be found. Database and S3 settings are required and validated, but their adapters are not connected yet. `S3_REGION` defaults to `us-east-1`; `S3_FORCE_PATH_STYLE` accepts `true` or `false` and defaults to `true` for the S3-compatible endpoint.

Balancing remains in `config/game.yaml`: timezone, positive integer daily quota, booster slots, rarity tables, and admin IDs. Tables contain percentages totaling 100 (with a small floating-point tolerance), using only COMMON, UNCOMMON, RARE, EPIC, and LEGENDARY; omitted rarities have zero probability. Every slot must reference an existing table. Quote Discord admin IDs to keep them strings; role IDs are validated but role authorization remains reserved for later. Invalid configuration stops startup with field-specific errors. `loadConfiguration` exposes typed environment and game settings to application code.

Run `npm run typecheck`, `npm test`, and `npm run lint` before submitting changes. Tests use a fake Discord client and need no credentials, database, or object store. Use `npm run format` to format source and tooling files.

For compiled execution, run `npm run build` then `npm start`. Both launch scripts load an optional local `.env`; deployment can supply environment variables directly. A failed startup exits with a nonzero status. Deployment files are deferred to the deployment issue.
