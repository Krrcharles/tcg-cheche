# Repository structure v0

Target structure for the initial implementation:

```text
.
├── AGENTS.md
├── config/
│   └── game.yaml
├── docs/
│   ├── architecture.md
│   ├── data-model.md
│   ├── domain.md
│   ├── repository-structure.md
│   └── decisions/
├── src/
│   ├── config/
│   ├── db/
│   │   ├── schema/
│   │   ├── repositories/
│   │   └── migrations/
│   ├── domain/
│   │   ├── cards/
│   │   ├── boosters/
│   │   ├── collections/
│   │   ├── trades/
│   │   └── administration/
│   ├── storage/
│   ├── discord/
│   │   ├── commands/
│   │   ├── components/
│   │   ├── presenters/
│   │   └── guards/
│   └── index.ts
├── tests/
├── Dockerfile
└── docker-compose.yml
```

## Intent

- `src/domain`: application/domain rules, independent from discord.js.
- `src/db`: Drizzle schema, migrations, repositories, and transactional data access.
- `src/storage`: S3-compatible object storage adapter.
- `src/discord`: Discord-specific input/output, commands, components, presenters, and authorization adapter.
- `src/config`: environment and `config/game.yaml` loading/validation.
- `tests`: focused unit/integration tests for business rules and persistence invariants.

This is a modular monolith. Do not split these modules into separate deployable services in v0.
