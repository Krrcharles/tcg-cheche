# ADR 001 — Runtime and data isolation

## Status

Accepted

## Context

TCG Cheche will have at least two Discord environments:

- a development/test bot used on a personal Discord server
- a production bot used on the main Discord server

The application should remain inexpensive to run on a small VPS. Card images are catalogue assets and are expected to be identical regardless of environment.

## Decision

### Application runtime

Development and production run as separate containers using the same Docker image and different configuration/secrets.

Architecture v0 assumes exactly one Discord guild per bot instance:

```text
tcg-dev  -> development Discord guild -> tcg_dev database
tcg-prod -> production Discord guild  -> tcg_prod database
```

The expected Discord guild ID is runtime configuration. An instance should reject or ignore interactions from other guilds.

Multi-guild support is explicitly out of scope for v0 and will be introduced only if a concrete product requirement appears.

### PostgreSQL

A single PostgreSQL server is shared by both environments, with two separate databases:

- `tcg_dev`
- `tcg_prod`

Environment-specific game state must never be shared between these databases.

Because each runtime serves one Discord guild, gameplay entities do not carry an otherwise redundant `guild_id` in v0.

### S3-compatible storage

A single RustFS server and a single bucket (`tcg-assets`) are shared by development and production.

Card assets are considered global catalogue data. A modification to an asset from either authorized environment may therefore become visible to the other environment immediately. This is accepted behavior.

Application code must use standard S3-compatible operations and must not depend on RustFS-specific APIs.

## Consequences

### Positive

- low infrastructure overhead on a small VPS
- strong separation between development and production game state
- simpler domain schema without unused guild scoping
- no duplicated binary asset storage
- a single application artifact can be promoted from development to production
- future migration from RustFS to another S3-compatible service does not require domain changes

### Accepted trade-offs

- one runtime cannot safely serve multiple Discord guilds without a future schema/domain change
- development can modify an asset that production also uses
- PostgreSQL and RustFS remain single points of failure on the VPS
- S3 data is not redundant merely because it is behind an object-storage API

External backup and restore procedures will be specified separately before production launch.
