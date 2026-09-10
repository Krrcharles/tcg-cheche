# Data model v0

This document translates the accepted domain rules into a PostgreSQL-oriented persistence model. It is intentionally implementation-oriented but remains subordinate to [`domain.md`](domain.md).

## Principles

- PostgreSQL is the source of truth for players, ownership, booster openings, and trades.
- One application instance serves one Discord guild, so guild IDs are not persisted in v0.
- Discord snowflake IDs are stored as text, never as JavaScript numbers.
- Primary keys are UUIDs.
- Timestamps are stored as `timestamptz` in UTC. Calendar-day calculations use the configured game timezone in application logic.
- Card instances are individually persisted even though they are indistinguishable to players in v0. This keeps ownership transfers explicit and leaves room for per-instance properties later.

## Tables

### `players`

```text
id                uuid primary key
discord_user_id   text not null unique
created_at        timestamptz not null
```

A player is created lazily the first time a gameplay operation needs one.

### `cards`

```text
id          uuid primary key
name        text not null
asset_key   text not null
rarity      text not null
enabled     boolean not null default true
created_at  timestamptz not null
updated_at  timestamptz not null
```

`name` is not unique. `id` is the identity of the card.

Initial allowed rarity values are:

```text
COMMON
UNCOMMON
RARE
EPIC
LEGENDARY
```

The application should reject unsupported rarity values. The persistence representation should avoid making probability changes require schema migrations.

### `booster_openings`

```text
id          uuid primary key
player_id   uuid not null -> players.id
opened_at   timestamptz not null
```

Recommended index:

```text
(player_id, opened_at)
```

The daily quota is derived by counting openings in the current configured calendar day. There is no mutable `boosters_remaining` column.

### `card_instances`

```text
id                   uuid primary key
card_id              uuid not null -> cards.id
owner_player_id      uuid not null -> players.id
obtained_at           timestamptz not null
obtained_source       text not null
booster_opening_id    uuid null -> booster_openings.id
```

Initial `obtained_source` values are expected to include:

```text
BOOSTER
ADMIN
```

A trade changes `owner_player_id`; it does not create a new card instance.

Recommended indexes:

```text
(owner_player_id, card_id)
(card_id)
```

The first index supports collection aggregation and quantity validation efficiently.

### `trades`

```text
id                    uuid primary key
proposer_player_id    uuid not null -> players.id
recipient_player_id   uuid not null -> players.id
status                text not null
created_at            timestamptz not null
completed_at          timestamptz null
```

Initial status values:

```text
PENDING
COMPLETED
REJECTED
CANCELLED
```

A player cannot trade with themselves.

Recommended indexes:

```text
(recipient_player_id, status, created_at)
(proposer_player_id, status, created_at)
```

### `trade_items`

```text
trade_id    uuid not null -> trades.id
side        text not null
card_id     uuid not null -> cards.id
quantity    integer not null check quantity > 0
```

Initial side values:

```text
PROPOSER
RECIPIENT
```

Recommended primary/unique key:

```text
(trade_id, side, card_id)
```

This ensures each card appears once per side and is represented by an aggregated quantity.

## Ownership model

The collection is derived from `card_instances`:

```sql
SELECT card_id, count(*)
FROM card_instances
WHERE owner_player_id = :player_id
GROUP BY card_id;
```

No separate collection table or mutable quantity counter is required in v0.

## Booster-opening transaction

The quota check and opening creation must be concurrency-safe.

A plain `COUNT` followed by an `INSERT` is insufficient under normal transaction isolation because two concurrent interactions could both observe the same remaining quota.

The intended approach is:

1. start a PostgreSQL transaction;
2. lock the player's row (`SELECT ... FOR UPDATE` or equivalent through the data-access layer);
3. count that player's successful openings for the current configured game day;
4. reject if the configured daily quota has been reached;
5. select the five cards according to the booster configuration;
6. insert one `booster_openings` row;
7. insert all five `card_instances` referencing that opening;
8. commit.

If any step fails, the entire transaction rolls back.

### Administrative daily reset

`/admin player reset-daily` is an explicit exception that clears quota history for testing or correction. In one transaction, lock the selected player's row, compute the current configured calendar day after the lock, clear `card_instances.booster_opening_id` links to that player's openings in `[local midnight, next local midnight)`, then delete only those `booster_openings` rows. Links must be cleared even for copies already transferred to another player. Preserve all card instances, current owners, `obtained_at`, and `obtained_source`. Other players' opening history and other days are unaffected. An unknown player is a no-op and is not created.

This deliberately discards the selected day's opening history and the corresponding provenance links rather than introducing a quota counter or altering historical timestamps. Log the actor, target, local day, and number of deleted openings after commit. Failures roll back both link updates and history deletion. Give/remove operations also lock the target player; removal locks and validates enough matching instances before deleting any, and grants use `obtained_source = 'ADMIN'` with no opening link.

## Trade-completion transaction

Pending trades do not reserve card instances.

When a recipient accepts a trade:

1. start a PostgreSQL transaction;
2. lock the two player rows in deterministic UUID order to avoid reciprocal-trade deadlocks;
3. lock/reload the trade and verify it is still `PENDING`;
4. revalidate all required card quantities for both players;
5. select and lock enough matching `card_instances` for every trade item;
6. update ownership of all selected instances;
7. set the trade to `COMPLETED` and set `completed_at`;
8. commit.

Any validation failure must result in no ownership change.

## Deletion policy

Physical card deletion is not part of v0.

Cards are disabled with `enabled = false`, preserving ownership and historical references.

Player deletion and cascading data-retention behavior are also out of scope for v0; foreign-key behavior should default to preserving referential integrity rather than cascading destructive deletes.
