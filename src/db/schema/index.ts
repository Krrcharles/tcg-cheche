import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const players = pgTable("players", {
  id: uuid("id").defaultRandom().primaryKey(),
  discordUserId: text("discord_user_id").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const cards = pgTable(
  "cards",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    assetKey: text("asset_key").notNull(),
    rarity: text("rarity", {
      enum: ["COMMON", "UNCOMMON", "RARE", "EPIC", "LEGENDARY"],
    }).notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "cards_rarity_check",
      sql`${table.rarity} in ('COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY')`,
    ),
  ],
);

export const boosterOpenings = pgTable(
  "booster_openings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id),
    openedAt: timestamp("opened_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("booster_openings_player_opened_idx").on(
      table.playerId,
      table.openedAt,
    ),
  ],
);

export const cardInstances = pgTable(
  "card_instances",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    cardId: uuid("card_id")
      .notNull()
      .references(() => cards.id),
    ownerPlayerId: uuid("owner_player_id")
      .notNull()
      .references(() => players.id),
    obtainedAt: timestamp("obtained_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    obtainedSource: text("obtained_source", {
      enum: ["BOOSTER", "ADMIN"],
    }).notNull(),
    boosterOpeningId: uuid("booster_opening_id").references(
      () => boosterOpenings.id,
    ),
  },
  (table) => [
    index("card_instances_owner_card_idx").on(
      table.ownerPlayerId,
      table.cardId,
    ),
    index("card_instances_card_idx").on(table.cardId),
    check(
      "card_instances_obtained_source_check",
      sql`${table.obtainedSource} in ('BOOSTER', 'ADMIN')`,
    ),
  ],
);

export const trades = pgTable(
  "trades",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    proposerPlayerId: uuid("proposer_player_id")
      .notNull()
      .references(() => players.id),
    recipientPlayerId: uuid("recipient_player_id")
      .notNull()
      .references(() => players.id),
    status: text("status", {
      enum: ["PENDING", "COMPLETED", "REJECTED", "CANCELLED"],
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("trades_recipient_status_created_idx").on(
      table.recipientPlayerId,
      table.status,
      table.createdAt,
    ),
    index("trades_proposer_status_created_idx").on(
      table.proposerPlayerId,
      table.status,
      table.createdAt,
    ),
    check(
      "trades_distinct_players_check",
      sql`${table.proposerPlayerId} <> ${table.recipientPlayerId}`,
    ),
    check(
      "trades_status_check",
      sql`${table.status} in ('PENDING', 'COMPLETED', 'REJECTED', 'CANCELLED')`,
    ),
  ],
);

export const tradeItems = pgTable(
  "trade_items",
  {
    tradeId: uuid("trade_id")
      .notNull()
      .references(() => trades.id),
    side: text("side", { enum: ["PROPOSER", "RECIPIENT"] }).notNull(),
    cardId: uuid("card_id")
      .notNull()
      .references(() => cards.id),
    quantity: integer("quantity").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tradeId, table.side, table.cardId] }),
    check("trade_items_quantity_check", sql`${table.quantity} > 0`),
    check(
      "trade_items_side_check",
      sql`${table.side} in ('PROPOSER', 'RECIPIENT')`,
    ),
  ],
);
