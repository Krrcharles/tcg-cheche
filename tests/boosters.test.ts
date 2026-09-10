import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadGameConfiguration } from "../src/config/game.js";
import { DrizzleBoosterRepository } from "../src/db/repositories/boosters.js";
import {
  boosterOpenings,
  cardInstances,
  cards,
  players,
} from "../src/db/schema/index.js";
import {
  BoosterQuotaError,
  BoosterService,
} from "../src/domain/boosters/booster-service.js";
import { rarities } from "../src/domain/cards/card.js";

const client = new PGlite();
const db = drizzle(client);
const repository = new DrizzleBoosterRepository(db);
const user = "987654321098765432";
let now = new Date("2026-09-10T12:00:00Z");
const config = loadGameConfiguration();
const service = new BoosterService(
  repository,
  config,
  () => 0,
  () => now,
);

beforeAll(async () => {
  await migrate(db, { migrationsFolder: "src/db/migrations" });
}, 30_000);
beforeEach(async () => {
  await client.exec(
    "TRUNCATE card_instances, booster_openings, players, cards CASCADE",
  );
  await db.insert(cards).values(
    rarities.map((rarity) => ({
      name: rarity,
      rarity,
      assetKey: `cards/${rarity}`,
    })),
  );
  now = new Date("2026-09-10T12:00:00Z");
});
afterAll(() => client.close());

describe("booster service and PostgreSQL persistence", () => {
  it("lazily creates one player with an exact snowflake and shows status without consuming quota", async () => {
    const status = await service.status(user);
    expect(status).toEqual({
      used: 0,
      remaining: 3,
      limit: 3,
      resetsAt: new Date("2026-09-10T22:00:00Z"),
    });
    expect(await service.status(user)).toEqual(status);
    expect(await db.select().from(players)).toEqual([
      expect.objectContaining({ discordUserId: user }),
    ]);
    expect(await db.select().from(boosterOpenings)).toEqual([]);
    expect(await db.select().from(cardInstances)).toEqual([]);
  });

  it("persists one opening and five distinct instances, preserving duplicates and provenance", async () => {
    const opening = await service.open(user);
    const [player] = await db.select().from(players);
    expect(opening.cards).toHaveLength(5);
    expect(opening.status.remaining).toBe(2);
    expect(await db.select().from(boosterOpenings)).toEqual([
      { id: opening.id, playerId: player?.id, openedAt: now },
    ]);
    const instances = await db.select().from(cardInstances);
    expect(instances).toHaveLength(5);
    expect(new Set(instances.map((instance) => instance.id)).size).toBe(5);
    expect(instances.map((instance) => instance.cardId).sort()).toEqual(
      opening.cards.map((card) => card.id).sort(),
    );
    for (const instance of instances)
      expect(instance).toMatchObject({
        ownerPlayerId: player?.id,
        obtainedSource: "BOOSTER",
        obtainedAt: now,
        boosterOpeningId: opening.id,
      });
  });

  it("enforces the configured quota independently per player", async () => {
    const custom = new BoosterService(
      repository,
      { ...config, boosters: { ...config.boosters, daily_limit: 1 } },
      () => 0,
      () => now,
    );
    await custom.open(user);
    await expect(custom.open(user)).rejects.toBeInstanceOf(BoosterQuotaError);
    expect((await custom.status(user)).remaining).toBe(0);
    await custom.open("987654321098765433");
    expect(await db.select().from(boosterOpenings)).toHaveLength(2);
    expect(await db.select().from(cardInstances)).toHaveLength(10);
  });

  it("rolls back the opening and all copies if a card-instance insert fails", async () => {
    await client.exec(`CREATE FUNCTION fail_booster_copy() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF (SELECT rarity FROM cards WHERE id = NEW.card_id) = 'RARE' THEN
      RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_booster_copy BEFORE INSERT ON card_instances FOR EACH ROW EXECUTE FUNCTION fail_booster_copy();`);
    try {
      await expect(service.open(user)).rejects.toThrow();
      expect(await db.select().from(boosterOpenings)).toEqual([]);
      expect(await db.select().from(cardInstances)).toEqual([]);
      expect((await service.status(user)).remaining).toBe(3);
    } finally {
      await client.exec(
        "DROP TRIGGER fail_booster_copy ON card_instances; DROP FUNCTION fail_booster_copy()",
      );
    }
    await expect(service.open(user)).resolves.toMatchObject({
      status: { remaining: 2 },
    });
  });

  it("does not consume quota for an incomplete catalogue and cannot roll disabled cards", async () => {
    await db
      .update(cards)
      .set({ enabled: false })
      .where(eq(cards.rarity, "LEGENDARY"));
    await expect(service.open(user)).rejects.toThrow(
      "no enabled LEGENDARY cards",
    );
    expect(await db.select().from(boosterOpenings)).toEqual([]);
    await db.insert(cards).values({
      name: "Enabled legendary",
      rarity: "LEGENDARY",
      assetKey: "cards/enabled",
    });
    const legendary = new BoosterService(
      repository,
      config,
      () => 0.999999,
      () => now,
    );
    expect(
      (await legendary.open(user)).cards.every(
        (card) => card.enabled && card.name === "Enabled legendary",
      ),
    ).toBe(true);
  });

  it.each([
    ["2026-01-10T23:00:00Z", "2026-01-11T23:00:00Z"],
    ["2026-07-10T22:00:00Z", "2026-07-11T22:00:00Z"],
    ["2026-03-28T23:00:00Z", "2026-03-29T22:00:00Z"],
    ["2026-10-24T22:00:00Z", "2026-10-25T23:00:00Z"],
  ])(
    "counts [start, end) for the Paris day %s, including DST",
    async (start, end) => {
      now = new Date(start);
      await service.status(user);
      const [player] = await db.select().from(players);
      if (!player) throw new Error("Missing player");
      await db
        .insert(boosterOpenings)
        .values(
          [
            new Date(new Date(start).getTime() - 1),
            new Date(start),
            new Date(new Date(end).getTime() - 1),
            new Date(end),
          ].map((openedAt) => ({ playerId: player.id, openedAt })),
        );
      expect(await service.status(user)).toMatchObject({
        used: 2,
        remaining: 1,
        resetsAt: new Date(end),
      });
      now = new Date(end);
      expect(await service.status(user)).toMatchObject({
        used: 1,
        remaining: 2,
      });
    },
  );

  it("resets an exhausted quota precisely at local midnight", async () => {
    now = new Date("2026-09-10T21:59:59.999Z");
    for (let i = 0; i < config.boosters.daily_limit; i++)
      await service.open(user);
    await expect(service.open(user)).rejects.toBeInstanceOf(BoosterQuotaError);
    now = new Date("2026-09-10T22:00:00Z");
    expect((await service.open(user)).status).toMatchObject({
      used: 1,
      remaining: 2,
    });
  });

  it("takes the operation time after the repository acquires the player lock", async () => {
    const delayed = new BoosterService(
      {
        withPlayer: (id, operation) =>
          repository.withPlayer(id, async (tx) => {
            now = new Date("2026-09-10T22:00:00Z");
            return operation(tx);
          }),
      },
      config,
      () => 0,
      () => now,
    );
    now = new Date("2026-09-10T21:59:59.999Z");
    expect((await delayed.open(user)).openedAt).toEqual(
      new Date("2026-09-10T22:00:00Z"),
    );
  });
});
