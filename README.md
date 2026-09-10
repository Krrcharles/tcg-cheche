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

Run `npm run typecheck`, `npm test`, and `npm run lint` before submitting changes. Tests use a fake Discord client and an in-memory PGlite PostgreSQL build for migration/constraint verification; they need no credentials, external database, or object store. Use `npm run format` to format source and tooling files.

For compiled execution, run `npm run build` then `npm start`. Both launch scripts load an optional local `.env`; deployment can supply environment variables directly. A failed startup exits with a nonzero status. Deployment files are deferred to the deployment issue.

## Card asset storage

`AssetStorage` in `src/storage/asset-storage.ts` exposes `put(assetKey, bytes, contentType)`, `get(assetKey)`, and `delete(assetKey)`. `S3AssetStorage` uses only the AWS SDK's standard S3 object operations. Construct it with the existing startup-validated `configuration.environment`; it uses all existing `S3_*` settings without rereading configuration. Call `destroy()` when its owner shuts down. The Discord bootstrap does not instantiate storage until a command needs it.

Asset keys such as `cards/charles/legendary-v1.webp` are passed through unchanged in the configured shared bucket. No environment prefix, public URL, ACL, bucket creation, or provider-specific API is involved. `put` uploads bytes with their supplied content type and replaces the current image at that key. Development and production therefore see the same replacement. `get` fully consumes the response into a Node.js `Buffer` suitable for Discord attachments; buffering one image in memory keeps the interface simple, while streaming and upload size/type validation are left for future callers. `delete` delegates directly to S3, including its behavior for missing objects and versioned buckets.

Failed requests, missing download bodies, and download-consumption failures reject with `AssetStorageError`, carrying `operation`, `assetKey`, and the original `cause`. A missing object is a failed read, not an empty image; provider errors such as `NoSuchKey` remain available through `cause`. The adapter does not log errors or credentials. Unit tests mock the SDK send boundary and cover configuration mapping, request construction, binary downloads, replacement, error handling, and client cleanup; live endpoint verification remains a deployment check.

## Database migrations

The v0 Drizzle schema is in `src/db/schema/index.ts`; generated SQL and migration metadata are versioned in `src/db/migrations`.

1. Create an empty PostgreSQL database and set `DATABASE_URL` in `.env` or the environment. Use separate databases for development and production.
2. From the repository root, run `npm run db:migrate`. Only database configuration is needed; Discord and S3 credentials are not required. Install development dependencies for this TypeScript tooling command.
3. After changing the schema, run `npm run db:generate -- --name=describe_change`, review the generated SQL, and commit the SQL and metadata together. Generation requires no database connection.

Migrations are explicit and are not run on bot startup. Drizzle records applied migrations, so rerunning `db:migrate` applies only new migrations. Foreign keys use PostgreSQL's non-cascading `NO ACTION` default. Status, rarity, source, and side values use text with check constraints; balancing changes do not require migrations. Application updates must set `cards.updated_at` when changing a card; its database default only supplies the creation timestamp.

`npm test` migrates a fresh in-memory PostgreSQL database, checks repeat migration execution, and exercises constraints and indexes. These tests verify schema behavior, not network connectivity or concurrent transactions on a PostgreSQL server. Booster/trade services and their transactional locking remain for their respective issues.
