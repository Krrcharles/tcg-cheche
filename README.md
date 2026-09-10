# TCG Cheche

Discord TCG built around a shared card catalogue and isolated game state per Discord guild.

## Project status

The project is currently in product/domain design. Implementation issues will be created once the core gameplay rules are specified.

## Architecture v0

- TypeScript + discord.js application
- PostgreSQL for persistent game state
- RustFS as an S3-compatible object store for card assets
- Docker Compose deployment on a small OVH VPS
- No Redis, currency system, marketplace, spawn system, public HTTP API, reverse proxy, or domain name in the initial architecture
- Development and production run the same application image with separate Discord bot tokens and separate PostgreSQL databases
- Development and production share the same S3 bucket because card assets belong to the global catalogue
- Game state is isolated per Discord guild

See [`docs/architecture.md`](docs/architecture.md) and [`docs/decisions/001-runtime-data-isolation.md`](docs/decisions/001-runtime-data-isolation.md).
