# TCG Cheche

Discord TCG built around a shared card catalogue, daily boosters, collections, and direct card-for-card trading.

## Project status

Product/domain design v0 is documented. The bot supports admin card catalogue and player maintenance commands, booster simulation, daily boosters, collection browsing, card details, bilateral trading, and graceful shutdown.

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

The bootstrap validates the environment and reads `config/game.yaml` once before connecting to Discord. Run launch commands from the repository root so the game file can be found. Database and S3 adapters serve the admin commands; run migrations and provision the bucket before using them. `S3_REGION` defaults to `us-east-1`; `S3_FORCE_PATH_STYLE` accepts `true` or `false` and defaults to `true` for the S3-compatible endpoint.

Balancing remains in `config/game.yaml`: timezone, positive integer daily quota, booster slots, rarity tables, and admin IDs. Tables contain percentages totaling 100 (with a small floating-point tolerance), using only COMMON, UNCOMMON, RARE, EPIC, and LEGENDARY; omitted rarities have zero probability. Every slot must reference an existing table. Quote Discord admin IDs to keep them strings; role IDs are validated but role authorization remains reserved for later. Invalid configuration stops startup with field-specific errors. `loadConfiguration` exposes typed environment and game settings to application code.

Run `npm run typecheck`, `npm test`, and `npm run lint` before submitting changes. Tests use a fake Discord client and an in-memory PGlite PostgreSQL build for migration/constraint verification; they need no credentials, external database, or object store. Use `npm run format` to format source and tooling files.

For compiled execution, run `npm run build` then `npm start`. Both launch scripts load an optional local `.env`; deployment can supply environment variables directly. A failed startup exits with a nonzero status. Deployment files are deferred to the deployment issue.

## Card asset storage

`AssetStorage` in `src/storage/asset-storage.ts` exposes `put(assetKey, bytes, contentType)`, `get(assetKey)`, and `delete(assetKey)`. `S3AssetStorage` uses only the AWS SDK's standard S3 object operations. Construct it with the existing startup-validated `configuration.environment`; it uses all existing `S3_*` settings without rereading configuration. The bootstrap instantiates it for the catalogue service and closes it together with the database pool on shutdown.

Asset keys such as `cards/charles/legendary-v1.webp` are passed through unchanged in the configured shared bucket. No environment prefix, public URL, ACL, bucket creation, or provider-specific API is involved. `put` uploads bytes with their supplied content type and replaces the current image at that key. Development and production therefore see the same replacement. `get` fully consumes the response into a Node.js `Buffer` suitable for Discord attachments; buffering one image in memory keeps the interface simple, while streaming and upload size/type validation are left for future callers. `delete` delegates directly to S3, including its behavior for missing objects and versioned buckets.

Failed requests, missing download bodies, and download-consumption failures reject with `AssetStorageError`, carrying `operation`, `assetKey`, and the original `cause`. A missing object is a failed read, not an empty image; provider errors such as `NoSuchKey` remain available through `cause`. The adapter does not log errors or credentials. Unit tests mock the SDK send boundary and cover configuration mapping, request construction, binary downloads, replacement, error handling, and client cleanup; live endpoint verification remains a deployment check.

## Database migrations

The v0 Drizzle schema is in `src/db/schema/index.ts`; generated SQL and migration metadata are versioned in `src/db/migrations`.

1. Create an empty PostgreSQL database and set `DATABASE_URL` in `.env` or the environment. Use separate databases for development and production.
2. From the repository root, run `npm run db:migrate`. Only database configuration is needed; Discord and S3 credentials are not required. Install development dependencies for this TypeScript tooling command.
3. After changing the schema, run `npm run db:generate -- --name=describe_change`, review the generated SQL, and commit the SQL and metadata together. Generation requires no database connection.

Migrations are explicit and are not run on bot startup. Drizzle records applied migrations, so rerunning `db:migrate` applies only new migrations. Foreign keys use PostgreSQL's non-cascading `NO ACTION` default. Status, rarity, source, and side values use text with check constraints; balancing changes do not require migrations. Application updates must set `cards.updated_at` when changing a card; its database default only supplies the creation timestamp.

Card names are unique case-insensitively across the catalogue, enforced by `cards_name_lower_unique` on `lower(name)`. Display casing is preserved. Migration `0001_unique_card_names` fails if existing names conflict; correct those names explicitly before retrying. It does not rename, merge, or delete cards. UUID primary/foreign keys and asset keys remain unchanged.

`npm test` migrates a fresh in-memory PostgreSQL database, checks repeat migration execution, and exercises constraints, indexes, booster transactions, and trade atomicity. PGlite serializes transactions; the separate real-server concurrency tests below verify row locking across independent connections.

## Daily boosters

Startup registers `/booster status` and `/booster open` in the configured guild. Normal players can use both. Discord makes a base command unusable when it has subcommands, so status uses the explicit `/booster status` form instead of bare `/booster` ([Discord documentation](https://docs.discord.com/developers/interactions/application-commands#subcommands-and-subcommand-groups)). Status is ephemeral; openings publicly reveal all five cards together, with names, rarities, and private S3 images attached. An additional public follow-up names the player and every legendary pulled, including duplicates, without sending mention notifications. Reveals, fallback messages, and announcements omit card UUIDs.

The engine reads slot definitions and rarity weights from the startup-loaded game configuration. Enabled cards within each rarity have equal chances; duplicates and unlimited supply are supported. Every positive-weight rarity used by a booster must have an enabled card. An incomplete catalogue rejects the opening without consuming quota rather than silently changing the odds. The checked-in standard booster uses four `normal` slots and a final `rare_plus` slot; the engine also supports other configured definitions without special-case rolling rules.

Each status/open lazily creates the player and locks that player's row in a PostgreSQL transaction at READ COMMITTED isolation. Opening reads the clock after acquiring the lock, checks the successful-opening count, rolls, and inserts the opening and all instances in that same transaction. Failed writes roll back completely. Calendar dates are derived in the configured timezone in the application; PostgreSQL converts both local midnights independently into UTC bounds for the indexed `[start, end)` count. This handles 23- and 25-hour daylight-saving days without a new timezone dependency.

Discord/S3 delivery happens after commit. A missing image leaves the saved card's text visible; a rejected reveal falls back to the saved card list. If Discord is unavailable entirely, the opening still exists and consumes quota: check status before retrying. Failed celebratory announcements are logged without overwriting a successful reveal. Images are buffered without resizing, as in the catalogue commands.

Run the server concurrency tests against a disposable PostgreSQL server by setting `TEST_DATABASE_URL` and running `npm test -- tests/boosters-concurrency.test.ts`. They use independent pooled connections and create, migrate, and remove a uniquely named database; the connection user needs `CREATEDB` permission. Tests cover simultaneous first-player creation and competing opens blocked on a held player row with one opening remaining. These tests are skipped when the variable is absent. The default suite requires no external services and covers deterministic rolls, quota/day/DST boundaries, rollback after an injected insert failure, and Discord presentation/failure paths.

## Collections and card details

`/collection [player]` opens a public list of the selected player's collection (your own by default), showing distinct cards, owned quantities, collection completion, and total copies. Buttons switch between list and gallery, move between pages, and sort by rarity descending (default), name ascending, or quantity descending. Both views show ten distinct cards per page; switching views preserves the page and sort, while changing sort returns to page one. Name and card UUID break sorting ties. Only the person who opened the view can use its controls; other players can open their own view.

`/card name:"Kevin au Buffalo Grill" [player]` shows a card's name, rarity, image, and owned quantity, including zero copies. Name lookup is case-insensitive, with up to 25 autocomplete suggestions from the whole catalogue, including disabled cards. Suggestions match literal substrings and preserve stored casing. Unknown names return `Card not found.` Lists, gallery descriptions, and card details display name, rarity, and quantity without card UUIDs. Gallery/detail images are retrieved through the private storage adapter and attached to Discord. Missing images leave the card text readable. These commands are available to normal players in the configured guild.

Completion counts all catalogue cards, including disabled ones, because disabling only changes future booster eligibility. Browsing does not create players or mutate ownership. A single PostgreSQL statement aggregates the selected player's copies alongside the catalogue, giving each collection read a consistent snapshot. Sorting and pagination happen in the Discord-independent service over that small catalogue; each button refreshes the data and clamps pages if the collection has shrunk. No schema changes, cache, or persistent UI sessions are needed. As with booster reveals, images are buffered without resizing; live Discord upload limits still apply.

## Card trading

`/trade player:@player` opens a private offer form. Enter one `Card Name xN` line in the two fields (what you give and what you request), for example `Kevin au Buffalo Grill x2`. The final `x<positive integer>` suffix is the quantity, so names may contain spaces. Names resolve case-insensitively to internal UUIDs before proposal persistence; unknown names fail cleanly. Submitting the form shows a private preview with card names, rarities, and quantities. Previews and saved trade messages omit card UUIDs. Edit the draft or send the proposal to post a public pending trade. Only the recipient can accept/reject; only the proposer can cancel. `/trade id:<trade-uuid>` reopens an existing trade with its current status and controls, including after a restart or failed delivery.

Repeated names resolving to the same card are aggregated on each side. Quantities must be positive integers; at least one side must contain a card, and either side may be empty. Disabled cards remain tradable. Creation validates the proposer's ownership and both sides' catalogue IDs; it does not reserve or lock instances. Requested ownership is checked on acceptance. Stale trades remain pending and transfer nothing, so they can be retried when ownership is sufficient or explicitly rejected/cancelled. There is no currency, counter-offer, editing of sent proposals, or automatic expiry.

Every action locks both player rows in UUID order, then locks/reloads the trade. Acceptance checks and locks all matching instances on both sides before moving any, and updates ownership plus completion status in one READ COMMITTED PostgreSQL transaction. Instance IDs and acquisition provenance are preserved. Competing accepts cannot complete twice. These player locks are shared with boosters and admin maintenance.

The builder uses text entry instead of collection pickers to keep the initial UI small. Each field supports Discord's 4,000-character limit; long previews/proposals attach the full offer as text instead of truncating quantities. Only one unsent draft per player is retained in memory and a new builder or restart discards it. Saved trades have no UI-session dependency. Discord delivery happens after the database commit; delivery failure does not undo a saved proposal or completed exchange. Reopen by the reported trade ID before retrying. Live Discord delivery still needs a guild smoke test.

Run `npm test -- tests/trades-concurrency.test.ts` with `TEST_DATABASE_URL` pointing at a disposable PostgreSQL server whose user has `CREATEDB`. The suite creates and removes its own database and checks held player locks, competing/double acceptance, reciprocal lock ordering, accept versus reject/cancel, creation's foreign-key lock ordering, creation with locked instances, and rollback after a completion-write failure. It skips when the variable is absent. The default suite covers input validation, permissions, stale quantities, same-card exchanges, transaction rollback, and Discord flows without external services.

## Admin card catalogue

Startup registers `/admin card` in `DISCORD_GUILD_ID` (the bot installation needs the `applications.commands` scope). Only exact string IDs in `admin.user_ids` can execute these operations, including reads. `role_ids` grants no access. Other guilds are ignored, and replies are ephemeral.

- `create name rarity image`: upload an image and create an enabled card. Names must be unique case-insensitively; UUIDs remain the technical identity. Create/edit name conflicts return a clear error. Admin catalogue and maintenance commands continue accepting UUIDs in v0.
- `edit id [name] [rarity]`: change at least one metadata field.
- `show id`: display the full record and attach its image from private S3 storage.
- `list [page]`: show ten cards per page, including disabled cards, sorted by name then UUID.
- `enable id` / `disable id`: change future booster eligibility while preserving ownership and trade references.
- `replace-image id image`: overwrite the existing shared asset key. This can affect both environments immediately.

Names must contain 1–100 characters after trimming. Image attachments must declare PNG, JPEG, WebP, or GIF and contain at most 8 MiB; the service checks the downloaded byte count too. Images are buffered without transcoding. Successful mutations log the actor, operation, and card UUID. No card-delete command is exposed.

New uploads use `cards/<uuid>` keys. S3 and PostgreSQL do not share a transaction: if upload succeeds but the database write fails, creation can leave an unused object, or replacement can succeed without updating `updated_at`. Check the record and storage before retrying; automatic deletion could remove an object referenced by a write whose outcome was uncertain. Concurrent image replacements follow S3's last successful write behavior. No new schema or dependencies are needed.

## Admin player maintenance and simulation

The same configured admin-user guard protects all `/admin player` and `/admin booster` commands, including reads. Replies are ephemeral and limited to the configured guild.

- `/admin player show player`: show the player's internal ID, distinct cards, total copies, current-day booster usage/remaining quota, and pending trades on either side. Unknown players show zero state without being created.
- `/admin player give-card player card quantity`: give copies identified by card UUID, including disabled cards, creating the player if needed. Copies have `ADMIN` provenance and consume no booster quota.
- `/admin player remove-card player card quantity`: remove that many copies of the selected card from the selected player, or fail without removing anything if there are too few. Pending trades reserve nothing and must revalidate ownership on acceptance.
- `/admin player reset-daily player`: clear only the selected player's opening history for the current configured calendar day. This restores their quota while preserving every card, its current owner, acquisition timestamp, and source, including cards already traded away. Links from those copies to the cleared opening records become null. Earlier/later days and other players' opening history stay intact. This intentionally loses the cleared opening history and its provenance links; use it for testing or exceptional correction.
- `/admin booster simulate [count]`: roll standard boosters using the same engine and startup-loaded configuration as real openings. The default is one booster. The reply shows rarity counts/percentages and attaches JSON with per-card UUID, name, rarity, and count (including enabled cards with zero draws). It reads the enabled catalogue once and never creates players, openings, or copies, consumes quota, or accesses images. An incomplete catalogue fails with the same error as real openings.

Give/remove quantities and simulation counts are limited to 1–1,000 per request to bound database writes and synchronous simulation work; these are operational limits, not game-balancing rules. Player maintenance transactions lock the selected player at READ COMMITTED isolation, matching booster opening coordination. Reset uses the same timezone and half-open local-day bounds as real quota checks, including DST, with time sampled after acquiring the lock. Clearing opening links and deleting history succeed atomically or both roll back. Successful mutations log actor, target, action, card/quantity when applicable, and the day/count for resets after commit. No new schema, dependencies, or persistent audit system are introduced.
