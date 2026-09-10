import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  boosterOpenings,
  cardInstances,
  cards,
  players,
  tradeItems,
  trades,
} from "../src/db/schema/index.js";

const client = new PGlite();
const db = drizzle(client);
const migrations = { migrationsFolder: "src/db/migrations" };
const proposer = "00000000-0000-4000-8000-000000000001";
const recipient = "00000000-0000-4000-8000-000000000002";
const card = "00000000-0000-4000-8000-000000000003";
const opening = "00000000-0000-4000-8000-000000000004";
const trade = "00000000-0000-4000-8000-000000000005";
const missing = "00000000-0000-4000-8000-000000000099";

beforeAll(async () => {
  await migrate(db, migrations);
  await db.insert(players).values([
    { id: proposer, discordUserId: "123456789012345678" },
    { id: recipient, discordUserId: "987654321098765432" },
  ]);
  await db.insert(cards).values({
    id: card,
    name: "Test card",
    assetKey: "cards/test.webp",
    rarity: "RARE",
  });
  await db.insert(boosterOpenings).values({ id: opening, playerId: proposer });
  await db.insert(cardInstances).values({
    cardId: card,
    ownerPlayerId: proposer,
    obtainedSource: "BOOSTER",
    boosterOpeningId: opening,
  });
  await db.insert(trades).values({
    id: trade,
    proposerPlayerId: proposer,
    recipientPlayerId: recipient,
    status: "PENDING",
  });
  await db
    .insert(tradeItems)
    .values({ tradeId: trade, side: "PROPOSER", cardId: card, quantity: 1 });
}, 30_000);
beforeEach(async () => {
  await client.exec("BEGIN");
});
afterEach(async () => {
  await client.exec("ROLLBACK");
});
afterAll(async () => {
  await client.close();
});

describe("v0 PostgreSQL migration", () => {
  it("creates all six tables from zero and records the migration only once", async () => {
    const tables = await client.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "booster_openings",
      "card_instances",
      "cards",
      "players",
      "trade_items",
      "trades",
    ]);
    // The migrator manages its own transaction; close the test transaction first.
    await client.exec("ROLLBACK");
    await migrate(db, migrations);
    const history = await client.query(
      "SELECT * FROM drizzle.__drizzle_migrations",
    );
    expect(history.rows).toHaveLength(1);
    expect(await db.select().from(cardInstances)).toHaveLength(1);
    await client.exec("BEGIN");
  });

  it("preserves snowflakes as text and uses UUIDs, timestamptz, and documented defaults", async () => {
    const [player] = await db
      .select()
      .from(players)
      .where(eq(players.id, recipient));
    expect(player?.discordUserId).toBe("987654321098765432");
    expect(player?.createdAt).toBeInstanceOf(Date);
    const [created] = await db
      .insert(cards)
      .values({
        name: "Test card",
        assetKey: "cards/other.webp",
        rarity: "COMMON",
      })
      .returning();
    expect(created?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created?.enabled).toBe(true);
    expect(created?.createdAt).toBeInstanceOf(Date);
    expect(created?.updatedAt).toBeInstanceOf(Date);
    const columns = await client.query<{
      column_name: string;
      data_type: string;
    }>(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public'",
    );
    for (const column of columns.rows) {
      if (column.column_name.endsWith("_at"))
        expect(column.data_type).toBe("timestamp with time zone");
      if (
        column.column_name === "id" ||
        (column.column_name.endsWith("_id") &&
          column.column_name !== "discord_user_id")
      )
        expect(column.data_type).toBe("uuid");
    }
  });

  it("allows duplicate owned copies, admin grants without an opening, and disabled owned cards", async () => {
    await db.insert(cardInstances).values({
      cardId: card,
      ownerPlayerId: proposer,
      obtainedSource: "ADMIN",
    });
    await db.update(cards).set({ enabled: false }).where(eq(cards.id, card));
    const copies = await db.select().from(cardInstances);
    expect(copies).toHaveLength(2);
    expect(copies.some((copy) => copy.boosterOpeningId === null)).toBe(true);
  });

  it("rejects duplicate Discord user IDs", async () => {
    await expect(
      client.query("INSERT INTO players (discord_user_id) VALUES ($1)", [
        "123456789012345678",
      ]),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it.each([0, -1])("rejects trade-item quantity %s", async (quantity) => {
    await expect(
      client.query("UPDATE trade_items SET quantity = $1", [quantity]),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "trade_items_quantity_check",
    });
  });

  it("rejects self-trades", async () => {
    await expect(
      client.query(
        "INSERT INTO trades (proposer_player_id, recipient_player_id, status) VALUES ($1, $1, 'PENDING')",
        [proposer],
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "trades_distinct_players_check",
    });
  });

  it("aggregates trade items uniquely per trade, side, and card", async () => {
    await db
      .insert(tradeItems)
      .values({ tradeId: trade, side: "RECIPIENT", cardId: card, quantity: 2 });
    await expect(
      client.query(
        "INSERT INTO trade_items (trade_id, side, card_id, quantity) VALUES ($1, 'PROPOSER', $2, 2)",
        [trade, card],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it.each([
    ["UPDATE cards SET rarity = 'MYTHIC'", "cards_rarity_check"],
    [
      "UPDATE card_instances SET obtained_source = 'OTHER'",
      "card_instances_obtained_source_check",
    ],
    ["UPDATE trades SET status = 'EXPIRED'", "trades_status_check"],
    ["UPDATE trade_items SET side = 'OTHER'", "trade_items_side_check"],
  ])("rejects unsupported values: %s", async (query, constraint) => {
    await expect(client.exec(query)).rejects.toMatchObject({
      code: "23514",
      constraint,
    });
  });

  it.each([
    "UPDATE booster_openings SET player_id = $1",
    "UPDATE card_instances SET card_id = $1",
    "UPDATE card_instances SET owner_player_id = $1",
    "UPDATE card_instances SET booster_opening_id = $1",
    "UPDATE trades SET proposer_player_id = $1",
    "UPDATE trades SET recipient_player_id = $1",
    "UPDATE trade_items SET trade_id = $1",
    "UPDATE trade_items SET card_id = $1",
  ])("rejects missing references: %s", async (query) => {
    await expect(client.query(query, [missing])).rejects.toMatchObject({
      code: "23503",
    });
  });

  it.each(["players", "cards", "booster_openings", "trades"])(
    "preserves referenced %s on deletion",
    async (table) => {
      await expect(client.exec(`DELETE FROM ${table}`)).rejects.toMatchObject({
        code: "23503",
      });
    },
  );

  it("creates the documented query indexes and non-cascading foreign keys", async () => {
    const indexes = await client.query<{ indexname: string; indexdef: string }>(
      "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'",
    );
    for (const [name, columns] of [
      ["booster_openings_player_opened_idx", "(player_id, opened_at)"],
      ["card_instances_owner_card_idx", "(owner_player_id, card_id)"],
      ["card_instances_card_idx", "(card_id)"],
      [
        "trades_recipient_status_created_idx",
        "(recipient_player_id, status, created_at)",
      ],
      [
        "trades_proposer_status_created_idx",
        "(proposer_player_id, status, created_at)",
      ],
    ]) {
      expect(
        indexes.rows.find((row) => row.indexname === name)?.indexdef,
      ).toContain(columns);
    }
    const foreignKeys = await client.query<{
      confdeltype: string;
      confupdtype: string;
    }>(
      "SELECT confdeltype, confupdtype FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace",
    );
    expect(foreignKeys.rows).toHaveLength(8);
    expect(
      foreignKeys.rows.every(
        (key) => key.confdeltype === "a" && key.confupdtype === "a",
      ),
    ).toBe(true);
  });
});
