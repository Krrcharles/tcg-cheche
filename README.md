# TCG Cheche

Discord TCG built around a shared card catalogue, daily boosters, collections, and direct card-for-card trading.

## Project status

Product/domain design v0 is documented and the repository now contains a Codex-ready implementation backlog.

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
