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

The two bot containers run the same application image. Their behavior differs only through environment configuration.

## Discord

The bot connects outbound to Discord. The MVP does not require a public HTTP API, reverse proxy, TLS termination, or a domain name.

Development and production use separate Discord applications/tokens.

## PostgreSQL

PostgreSQL is the source of truth for game state.

Development and production use distinct databases on the same PostgreSQL server:

- `tcg_dev`
- `tcg_prod`

This isolates migrations, test data, collections, booster openings, trades, and player state while avoiding the resource cost of running two PostgreSQL instances.

PostgreSQL must not be exposed publicly from the VPS.

## Guild isolation

The application is multi-guild by design.

A Discord user participating in two Discord guilds is treated as two distinct players for gameplay purposes. Collections, booster quotas, trades, and other game state are scoped to a guild.

Conceptually:

```text
guild
└── player (guild_id + discord_user_id)
    ├── collection
    ├── booster openings
    └── trades
```

The card catalogue itself is global.

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
└── application code and configuration

PostgreSQL
└── game/domain state

RustFS / S3
└── binary assets
```

## Deployment principles

- one Docker image for the application
- separate dev/prod containers
- shared PostgreSQL process, separate databases
- shared RustFS process and S3 bucket
- persistent Docker volumes for PostgreSQL and RustFS
- PostgreSQL and RustFS private to the Docker network
- external backups are a separate concern and will be designed before production launch
