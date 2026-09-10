# ADR 001 — Runtime and data isolation

## Status

Accepted

## Context

TCG Cheche will have at least two Discord environments:

- a development/test bot used on a personal Discord server
- a production bot used on the main Discord server

The application should remain inexpensive to run on a small VPS. Card images are catalogue assets and are expected to be identical regardless of environment.

The application may later be installed on more than one Discord guild, so guild-level game isolation must also be defined independently from dev/prod isolation.

## Decision

### Application runtime

Development and production run as separate containers using the same Docker image and different configuration/secrets.

### PostgreSQL

A single PostgreSQL server is shared by both environments, with two separate databases:

- `tcg_dev`
- `tcg_prod`

Environment-specific game state must never be shared between these databases.

### S3-compatible storage

A single RustFS server and a single bucket (`tcg-assets`) are shared by development and production.

Card assets are considered global catalogue data. A modification to an asset from either authorized environment may therefore become visible to the other environment immediately. This is accepted behavior.

Application code must use standard S3-compatible operations and must not depend on RustFS-specific APIs.

### Discord guild isolation

Within either environment, gameplay state is scoped by Discord guild. The same Discord user in two guilds has separate collections, booster quotas, and trades.

The card catalogue is global; ownership and gameplay state are guild-scoped.

## Consequences

### Positive

- low infrastructure overhead on a small VPS
- strong separation between development and production game state
- no duplicated binary asset storage
- a single application artifact can be promoted from development to production
- future migration from RustFS to another S3-compatible service does not require domain changes
- the bot can safely support multiple Discord guilds

### Accepted trade-offs

- development can modify an asset that production also uses
- PostgreSQL and RustFS remain single points of failure on the VPS
- S3 data is not redundant merely because it is behind an object-storage API

External backup and restore procedures will be specified separately before production launch.
