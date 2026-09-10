# Domain model v0

This document captures the current game rules. It is intentionally small and should evolve as product decisions are made.

## Card

A card is primarily an image asset. Card creation and image generation are out of scope for this project.

Minimal metadata required by the application:

```text
Card
- id
- asset_key
- rarity
- enabled
```

`asset_key` references the shared S3-compatible object storage.

`enabled` controls whether a card can appear in future booster openings without deleting existing owned copies.

### Rarities

The initial rarity scale is:

1. COMMON
2. UNCOMMON
3. RARE
4. EPIC
5. LEGENDARY

Rarity probabilities are configuration, not hard-coded domain rules, and must be easy to rebalance later.

## Owned card / card instance

Opening a booster creates owned card instances.

Multiple players may own the same card and the same player may own multiple copies of the same card.

```text
CardInstance
- id
- card_id
- owner_player_id
- obtained_at
- obtained_from
```

Additional properties such as serial numbers, foil variants, editions, etc. are not part of v0.

## Supply

Card supply is unlimited.

There is no global maximum number of instances of a card.

## Booster

The initial standard booster contains exactly 5 cards.

At least one of those cards must have rarity RARE or better.

The intended implementation is slot-based rather than applying a corrective rule after rolling five independent cards:

```text
standard booster
- slot 1: normal
- slot 2: normal
- slot 3: normal
- slot 4: normal
- slot 5: rare_or_better
```

Each slot references a configurable rarity distribution.

This allows booster composition and rarity probabilities to evolve without changing the core opening algorithm.

## Duplicate rules

Duplicates are allowed inside the same booster.

A booster may therefore contain two or more instances of exactly the same card.

There is no duplicate-protection rule in v0.

## Card selection

After a rarity is rolled for a slot, one enabled card of that rarity is selected from the catalogue.

Unless a future product decision introduces per-card weights, all enabled cards within a rarity are selected uniformly.

## Probability configuration

Exact rarity probabilities are not decided yet.

They should live in versioned application configuration rather than being embedded throughout business logic or requiring database migrations.

Conceptually:

```text
normal:
  COMMON: ...
  UNCOMMON: ...
  RARE: ...
  EPIC: ...
  LEGENDARY: ...

rare_or_better:
  RARE: ...
  EPIC: ...
  LEGENDARY: ...
```

The configuration format should support adding new booster definitions or slot distributions later without rewriting the booster engine.

## Current invariants

- a standard booster contains exactly 5 card instances
- a standard booster guarantees at least one RARE-or-better card
- duplicates within a booster are allowed
- card supply is unlimited
- disabled cards are not eligible for new booster rolls
- opening a booster must create all resulting card instances atomically or none of them
