# Architecture v0

## Goals

Keep the system small enough to operate on a single low-cost VPS while preserving clean domain boundaries and an easy migration path if the project grows.

## Runtime topology

```text
OVH VPS
└── Docker Compose
    ├── tcg-prod
    │   └── TypeScript / discord.js
    ├── tcg-dev
    │   └── TypeScript / discord.js
    ├── postgres
    │   ├── database: tcg_prod
    │   └── database: tcg_dev
    └── rustfs
        └── bucket: tcg-assets
```

The two bot containers run the same application image. Their behavior differs through environment configuration and by which Discord application/guild they are attached to.

## Discord

The bot connects outbound to Discord. The MVP does not require a public HTTP API, reverse proxy, TLS termination, or a domain name.

Development and production use separate Discord applications/tokens.

Architecture v0 intentionally assumes one bot instance serves one Discord guild:

```text
tcg-dev  -> development Discord guild -> tcg_dev database
tcg-prod -> production Discord guild  -> tcg_prod database
```

The expected guild ID is environment configuration. An instance should reject or ignore interactions from another guild.

Multi-guild support is out of scope for v0. If the product later needs one bot instance to serve multiple guilds, guild scoping will be introduced explicitly at that time rather than being carried as unused domain complexity now.

## PostgreSQL

PostgreSQL is the source of truth for game state.

Development and production use distinct databases on the same PostgreSQL server:

- `tcg_dev`
- `tcg_prod`

This isolates migrations, test data, collections, booster openings, trades, and player state while avoiding the resource cost of running two PostgreSQL instances.

PostgreSQL must not be exposed publicly from the VPS.

## Game configuration

Infrastructure/secrets and game balancing configuration are separate concerns.

Environment variables are reserved for deployment-specific configuration such as:

- Discord token
- expected Discord guild ID
- PostgreSQL connection string
- S3 endpoint
- S3 credentials
- runtime environment name

Game rules that are expected to evolve through balancing live in a versioned configuration file, initially `config/game.yaml`.

Examples include:

- game timezone
- daily booster quota
- booster composition
- rarity probability tables

The application must validate the complete game configuration at startup and fail fast on invalid configuration, for example unknown rarities, missing slot tables, or probability tables with invalid totals.

Game rules must not be duplicated as magic constants throughout application code.

## Object storage

RustFS provides the local S3-compatible object store.

A single shared bucket is used by both development and production:

```text
tcg-assets
└── cards/
```

This is intentional: card assets belong to the global catalogue and are not environment-specific game state.

It is acceptable for an authorized asset update performed from development to become visible immediately in production.

Application code must depend on the S3 protocol/API rather than on RustFS-specific APIs. RustFS should therefore be replaceable by another S3-compatible provider without changing domain logic.

The database stores asset keys rather than provider-specific public URLs.

Example:

```text
cards/charles/legendary-v1.webp
```

RustFS must not be publicly exposed unless a later product requirement makes that necessary. The bot can retrieve assets over the private Docker network and upload them to Discord as attachments.

## Redis

Redis is intentionally not part of architecture v0.

Current requirements do not justify an additional cache, distributed lock service, or job queue. Daily booster quotas and transactional integrity can be implemented directly with PostgreSQL.

Redis can be introduced later if a concrete scaling or coordination requirement appears.

## Persistence responsibilities

```text
Git
├── application code
└── versioned game configuration

PostgreSQL
└── game/domain state

RustFS / S3
└── binary assets
```

## Deployment principles

- one Docker image for the application
- separate dev/prod containers
- one Discord guild per bot instance in v0
- shared PostgreSQL process, separate databases
- shared RustFS process and S3 bucket
- persistent Docker volumes for PostgreSQL and RustFS
- PostgreSQL and RustFS private to the Docker network
- external backups are a separate concern and will be designed before production launch
