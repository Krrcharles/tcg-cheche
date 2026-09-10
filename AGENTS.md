# AGENTS.md

## Project intent

TCG Cheche is a small Discord TCG for one private Discord guild per application instance. The repository should remain easy to understand, test, and operate on a low-cost VPS.

Before changing behavior, read:

- `docs/domain.md`
- `docs/architecture.md`
- `docs/data-model.md`
- `docs/decisions/`

These files define the current product and architecture decisions.

## Technology direction

Unless an issue explicitly changes this direction, use:

- TypeScript
- Node.js
- discord.js
- PostgreSQL
- Drizzle ORM
- Zod for configuration validation
- YAML for versioned game configuration
- AWS SDK S3 client against an S3-compatible endpoint
- Vitest for tests
- Docker / Docker Compose for deployment

Do not add Redis, NestJS, a public HTTP API, a frontend, a reverse proxy, or microservices unless an issue explicitly requires them.

## Architectural boundaries

Discord is an adapter/presentation layer, not the domain.

Discord command handlers and component handlers should:

1. parse interaction input;
2. authorize when necessary;
3. call an application/domain service;
4. render the returned result.

Domain/application code must not depend on discord.js interaction or message classes.

Persistence logic belongs behind repositories/data-access modules. Avoid embedding SQL/Drizzle queries throughout Discord handlers.

S3/object-storage code must use standard S3-compatible operations and must not depend on RustFS-specific APIs.

## Configuration

Keep deployment secrets/infrastructure settings in environment variables.

Examples:

- Discord bot token
- Discord guild ID
- database URL
- S3 endpoint
- S3 access key / secret
- S3 bucket

Keep balancing/gameplay rules in `config/game.yaml`.

The game configuration must be parsed and validated once at application startup. Fail fast with a clear error if it is invalid.

Do not duplicate balancing values as magic constants in application code.

## Discord IDs

Discord snowflake IDs must be represented as strings. Never coerce them to JavaScript `number`.

One application instance serves one configured Discord guild in v0. Ignore or reject interactions coming from another guild.

## Data integrity

Transactions and concurrency constraints described in `docs/data-model.md` are requirements, not optional implementation details.

In particular:

- booster quota check + opening + card-instance creation are atomic;
- concurrent booster opens must not exceed the daily quota;
- pending trades reserve nothing;
- trade acceptance revalidates ownership;
- completed trades transfer all required cards atomically or none;
- lock multiple players in deterministic order to reduce deadlock risk.

Do not replace these invariants with in-memory locks. PostgreSQL is the source of truth.

## Domain simplicity

Do not prematurely add concepts not present in the accepted domain, including:

- currency
- marketplace
- card supply limits
- serial numbers
- foil/variant instances
- spawn mechanics
- automatic trade expiration
- multi-guild state in one database

Prefer the smallest design that satisfies the current issue and preserves the documented extension points.

## Tests

Business rules should be testable without Discord.

Add focused tests for domain/application logic, especially:

- game configuration validation
- weighted rarity selection
- rare-or-better slot guarantee
- daily booster quota boundaries
- collection aggregation and sorting
- trade validation and atomic completion
- admin authorization

For random behavior, make the random source injectable or otherwise controllable in tests. Avoid flaky statistical unit tests for deterministic rules.

## Issue scope

Implement only the requested issue plus the minimum supporting work required for it.

If an issue conflicts with existing docs, call out the conflict in the PR rather than silently changing product behavior.

Keep PRs small enough to review. Do not refactor unrelated areas opportunistically.
