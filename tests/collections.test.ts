import { PGlite } from "@electric-sql/pglite";
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
import { DrizzleCollectionRepository } from "../src/db/repositories/collections.js";
import { cardInstances, cards, players } from "../src/db/schema/index.js";
import { type Rarity, rarities } from "../src/domain/cards/card.js";
import {
  CollectionInputError,
  CollectionService,
} from "../src/domain/collections/collection-service.js";

const client = new PGlite();
const db = drizzle(client);
const repository = new DrizzleCollectionRepository(db);
const service = new CollectionService(repository);
const userId = "987654321098765432";
const otherUser = "987654321098765433";
const missing = "00000000-0000-4000-8000-000000000099";
let ownerId: string;

beforeAll(async () => {
  await migrate(db, { migrationsFolder: "src/db/migrations" });
}, 30_000);
beforeEach(async () => {
  await client.exec("BEGIN");
  const [owner] = await db
    .insert(players)
    .values({ discordUserId: userId })
    .returning();
  if (!owner) throw new Error("Missing player");
  ownerId = owner.id;
});
afterEach(async () => {
  await client.exec("ROLLBACK");
});
afterAll(async () => {
  await client.close();
});

async function addCard(
  name: string,
  rarity: Rarity,
  quantity = 1,
  enabled = true,
) {
  const [card] = await db
    .insert(cards)
    .values({ name, rarity, enabled, assetKey: `cards/${name}` })
    .returning();
  if (!card) throw new Error("Missing card");
  if (quantity)
    await db.insert(cardInstances).values(
      Array.from({ length: quantity }, () => ({
        cardId: card.id,
        ownerPlayerId: ownerId,
        obtainedSource: "ADMIN" as const,
      })),
    );
  return card;
}

describe("collection service and PostgreSQL aggregation", () => {
  it("aggregates duplicate instances, keeps disabled cards and counts the whole catalogue", async () => {
    const owned = await addCard("Owned", "RARE", 3, false);
    const other = await addCard("Other player's card", "COMMON", 0);
    await addCard("Unowned disabled", "EPIC", 0, false);
    const [player] = await db
      .insert(players)
      .values({ discordUserId: otherUser })
      .returning();
    if (!player) throw new Error("Missing player");
    await db.insert(cardInstances).values({
      cardId: other.id,
      ownerPlayerId: player.id,
      obtainedSource: "ADMIN",
    });
    expect(await service.list({ userId })).toMatchObject({
      collectedCount: 1,
      catalogueCount: 3,
      totalCopies: 3,
      entries: [
        {
          cardId: owned.id,
          ownedCount: 3,
          name: owned.name,
          rarity: "RARE",
          assetKey: owned.assetKey,
        },
      ],
    });
    expect((await service.list({ userId: otherUser })).entries).toMatchObject([
      { cardId: other.id, ownedCount: 1 },
    ]);
  });

  it("defaults to every rarity highest to lowest", async () => {
    for (const rarity of rarities) await addCard(rarity, rarity);
    const result = await service.list({ userId });
    expect(result.sort).toBe("rarity");
    expect(result.entries.map((entry) => entry.rarity)).toEqual(
      [...rarities].reverse(),
    );
  });

  it.each(["rarity", "name", "quantity"] as const)(
    "sorts by %s with stable name/UUID ties",
    async (sort) => {
      const zulu = await addCard("Zulu", "LEGENDARY", 1);
      const bravo = await addCard("Bravo", "RARE", 3);
      const alpha = await addCard("Alpha", "RARE", 2);
      const tied = await addCard("Alpha", "RARE", 2);
      const ties = [alpha.id, tied.id].sort();
      const expected =
        sort === "rarity"
          ? [zulu.id, ...ties, bravo.id]
          : sort === "name"
            ? [...ties, bravo.id, zulu.id]
            : [bravo.id, ...ties, zulu.id];
      expect(
        (await service.list({ userId, sort })).entries.map(
          (entry) => entry.cardId,
        ),
      ).toEqual(expected);
    },
  );

  it("paginates distinct cards without losing totals and clamps stale pages", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 12; i++)
      ids.push(
        (await addCard(`Card ${String(i).padStart(2, "0")}`, "COMMON", 2)).id,
      );
    const first = await service.list({ userId });
    const second = await service.list({ userId, page: 2 });
    expect(first.entries.map((entry) => entry.cardId)).toEqual(
      ids.slice(0, 10),
    );
    expect(second.entries.map((entry) => entry.cardId)).toEqual(ids.slice(10));
    for (const page of [first, second])
      expect(page).toMatchObject({
        pageCount: 2,
        totalCopies: 24,
        collectedCount: 12,
        catalogueCount: 12,
      });
    expect(await service.list({ userId, page: 999 })).toEqual(second);
  });

  it("returns empty collections without creating a player, including an empty catalogue", async () => {
    expect(await service.list({ userId: otherUser, page: 8 })).toMatchObject({
      entries: [],
      page: 1,
      pageCount: 1,
      catalogueCount: 0,
      collectedCount: 0,
      totalCopies: 0,
    });
    await addCard("Unowned", "COMMON", 0);
    expect(await service.list({ userId: otherUser })).toMatchObject({
      entries: [],
      catalogueCount: 1,
      totalCopies: 0,
    });
    expect(await db.select().from(players)).toHaveLength(1);
  });

  it("shows owned, disabled and unowned card details, and distinguishes missing cards", async () => {
    const card = await addCard("Disabled", "EPIC", 4, false);
    expect(await service.detail(userId, card.id)).toMatchObject({
      cardId: card.id,
      name: "Disabled",
      ownedCount: 4,
      rarity: "EPIC",
      assetKey: card.assetKey,
    });
    expect(await service.detail(otherUser, card.id)).toMatchObject({
      ownedCount: 0,
    });
    await expect(service.detail(userId, missing)).rejects.toThrow(
      "Card not found",
    );
  });

  it.each([
    { userId: "abc" },
    { userId, page: 0 },
    { userId, page: 1.5 },
    { userId, page: 1_000_001 },
    { userId, sort: "unknown" },
  ])("rejects invalid query input %j", async (input) => {
    await expect(
      service.list(input as Parameters<CollectionService["list"]>[0]),
    ).rejects.toThrow(CollectionInputError);
  });
  it("rejects invalid card IDs and numeric snowflakes", async () => {
    await expect(service.detail(userId, "bad")).rejects.toThrow(
      CollectionInputError,
    );
    await expect(
      service.list({ userId: 123 as unknown as string }),
    ).rejects.toThrow(CollectionInputError);
  });
});
