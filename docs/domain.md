# Domain model v0

This document captures the current game rules. It is intentionally small and should evolve as product decisions are made.

## Card

A card is primarily an image asset. Card creation and image generation are out of scope for this project.

Minimal metadata required by the application:

```text
Card
- id
- name
- asset_key
- rarity
- enabled
```

`name` is the human-readable display name used by Discord interactions such as drop announcements, collection views, and trades. It is not required to be unique; `id` remains the technical identity of the card.

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

## Daily booster quota

The initial rule is 3 booster openings per player per calendar day.

The game day resets at midnight in the timezone configured in `config/game.yaml`, initially `Europe/Paris`.

The quota is a balancing value and must come from game configuration rather than application code.

The application stores successful booster openings instead of maintaining a mutable `boosters_remaining` counter.

Conceptually:

```text
BoosterOpening
- id
- player_id
- opened_at
```

The number of openings for the current local game day determines whether another opening is allowed.

Quota validation and creation of the opening/card instances must be concurrency-safe and atomic so simultaneous Discord interactions cannot exceed the daily limit.

## Duplicate rules

Duplicates are allowed inside the same booster.

A booster may therefore contain two or more instances of exactly the same card.

There is no duplicate-protection rule in v0.

## Card selection

After a rarity is rolled for a slot, one enabled card of that rarity is selected from the catalogue.

Unless a future product decision introduces per-card weights, all enabled cards within a rarity are selected uniformly.

## Probability configuration

Exact rarity probabilities are not decided yet.

They should live in the versioned `config/game.yaml` rather than being embedded throughout business logic or requiring database migrations.

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

## Discord booster presentation

The v0 Discord experience is intentionally simple.

When a booster is opened successfully, all 5 resulting cards are revealed at once. The response should include their images and enough textual information to identify them.

If the booster contains one or more LEGENDARY cards, the bot emits an additional celebratory announcement identifying the player and the legendary card(s).

The Discord presentation must remain separate from the booster/domain logic. The domain returns the opening result; a Discord presenter decides how to render it.

This keeps future presentation changes possible without changing booster rules, including progressive reveals, buttons, animations, richer embeds, or different rarity-specific effects.

## Collection

The collection experience has two complementary presentations over the same collection data.

### List view

`/collection` opens the list view by default. A target player may also be supported, for example `/collection @player`.

The list view is the reference functional view: compact, textual, practical, sortable, and paginated.

Each distinct card is aggregated rather than listing individual owned instances.

A row contains at least:

```text
card name | rarity | owned quantity
```

The header should expose both collection completion and total owned copies when possible, for example:

```text
42 / 87 cards collected · 116 total copies
```

Initial sorting options:

- rarity, highest to lowest (default)
- name, alphabetical
- quantity, highest to lowest

Pagination is handled through Discord components rather than requiring repeated slash commands.

### Gallery view

The player can switch from the list view to a visual gallery from the same interaction.

The gallery displays card images in paginated groups, initially up to 10 distinct cards per page to fit Discord media-gallery capabilities.

The gallery uses the same collection query, sorting state, and pagination semantics as the list view. It is a presentation mode, not a separate domain concept.

The player can switch back to the list view without issuing a new command.

### Card detail

A card can be inspected individually through a command such as `/card`.

The detail view should show at least:

- card name
- rarity
- full card image
- number of copies owned by the requesting/selected player

This view may later become an entry point for additional actions such as trading, but no such coupling is required in v0.

### Presentation boundary

Collection/domain services return Discord-agnostic data such as:

```text
CollectionEntry
- card_id
- name
- rarity
- owned_count
- asset_key
```

Discord-specific list, gallery, navigation, and detail rendering belong in presenters/components outside the domain layer.

This is intentional so the collection UX can become richer later without changing collection ownership rules or persistence.

## Current invariants

- a standard booster contains exactly 5 card instances
- a standard booster guarantees at least one RARE-or-better card
- the initial daily quota is 3 boosters per player
- the game day uses a configured timezone, initially Europe/Paris
- duplicates within a booster are allowed
- card supply is unlimited
- disabled cards are not eligible for new booster rolls
- opening a booster must create all resulting card instances atomically or none of them
- booster/domain logic must not depend on a specific Discord rendering strategy
- collection list and gallery views are presentations over the same aggregated collection data
