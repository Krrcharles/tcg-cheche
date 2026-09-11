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
  vi,
} from "vitest";
import { loadGameConfiguration } from "../src/config/game.js";
import { DrizzleBoosterRepository } from "../src/db/repositories/boosters.js";
import { DrizzleMaintenanceRepository } from "../src/db/repositories/maintenance.js";
import {
  boosterOpenings,
  cardInstances,
  cards,
  players,
  tradeItems,
  trades,
} from "../src/db/schema/index.js";
import {
  AdminAuthorizationError,
  createAdminGuard,
} from "../src/domain/administration/admin-guard.js";
import {
  InsufficientCopiesError,
  MaintenanceInputError,
  type MaintenanceRequest,
  MaintenanceService,
} from "../src/domain/administration/maintenance-service.js";
import { BoosterService } from "../src/domain/boosters/booster-service.js";
import { rollBooster } from "../src/domain/boosters/engine.js";
import { type Card, rarities } from "../src/domain/cards/card.js";
import { CardNotFoundError } from "../src/domain/cards/card-service.js";

const client = new PGlite();
const db = drizzle(client);
const config = loadGameConfiguration();
const actor = "987654321098765432";
const targetUserId = "123456789012345678";
const otherUserId = "123456789012345679";
const repository = new DrizzleMaintenanceRepository(db);
let now = new Date("2026-09-10T12:00:00Z");
const service = new MaintenanceService(
  repository,
  config,
  createAdminGuard({ user_ids: [actor], role_ids: [] }),
  () => 0,
  () => now,
);
const boosters = new BoosterService(
  new DrizzleBoosterRepository(db),
  config,
  () => 0,
  () => now,
);
let card: Card;

beforeAll(async () => {
  await migrate(db, { migrationsFolder: "src/db/migrations" });
}, 30_000);
beforeEach(async () => {
  await client.exec(
    "TRUNCATE trade_items, trades, card_instances, booster_openings, players, cards CASCADE",
  );
  const catalogue = await db
    .insert(cards)
    .values(
      rarities.map((rarity) => ({
        name: rarity,
        rarity,
        assetKey: `cards/${rarity}`,
      })),
    )
    .returning();
  const first = catalogue[0];
  if (!first) throw new Error("Missing fixture card");
  card = first;
  now = new Date("2026-09-10T12:00:00Z");
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => client.close());

function execute(input: MaintenanceRequest) {
  return service.execute(actor, input);
}
function give(quantity = 3) {
  return execute({
    operation: "give-card",
    targetUserId,
    cardId: card.id,
    quantity,
  });
}
async function snapshot() {
  return {
    players: await db.select().from(players).orderBy(players.id),
    cards: await db.select().from(cards).orderBy(cards.id),
    copies: await db.select().from(cardInstances).orderBy(cardInstances.id),
    openings: await db
      .select()
      .from(boosterOpenings)
      .orderBy(boosterOpenings.id),
    trades: await db.select().from(trades).orderBy(trades.id),
    items: await db.select().from(tradeItems),
  };
}

describe("admin player maintenance", () => {
  it("shows an unknown player and resets zero history without creating a player", async () => {
    expect(await execute({ operation: "show", targetUserId })).toMatchObject({
      playerId: null,
      collectedCount: 0,
      totalCopies: 0,
      used: 0,
      remaining: config.boosters.daily_limit,
      pendingTrades: 0,
    });
    expect(console.info).not.toHaveBeenCalled();
    expect(
      await execute({ operation: "reset-daily", targetUserId }),
    ).toMatchObject({ clearedOpenings: 0 });
    expect(await db.select().from(players)).toEqual([]);
  });

  it("gives disabled cards by quantity, preserves exact IDs, and logs after success", async () => {
    await db.update(cards).set({ enabled: false }).where(eq(cards.id, card.id));
    await give();
    const state = await snapshot();
    expect(state.players).toEqual([
      expect.objectContaining({ discordUserId: targetUserId }),
    ]);
    expect(state.copies).toHaveLength(3);
    for (const copy of state.copies)
      expect(copy).toMatchObject({
        cardId: card.id,
        ownerPlayerId: state.players[0]?.id,
        obtainedSource: "ADMIN",
        obtainedAt: now,
        boosterOpeningId: null,
      });
    expect(state.openings).toEqual([]);
    expect(console.info).toHaveBeenCalledWith("Admin player mutation", {
      actorUserId: actor,
      targetUserId,
      action: "give-card",
      cardId: card.id,
      quantity: 3,
    });
  });

  it("shows aggregate collection, configured quota, and pending trades on both sides", async () => {
    await give();
    await boosters.open(targetUserId);
    await boosters.status(otherUserId);
    const people = await db.select().from(players);
    const target = people.find((p) => p.discordUserId === targetUserId);
    const other = people.find((p) => p.discordUserId === otherUserId);
    if (!target || !other) throw new Error("Missing players");
    await db.insert(trades).values([
      {
        proposerPlayerId: target.id,
        recipientPlayerId: other.id,
        status: "PENDING",
      },
      {
        proposerPlayerId: other.id,
        recipientPlayerId: target.id,
        status: "PENDING",
      },
      {
        proposerPlayerId: target.id,
        recipientPlayerId: other.id,
        status: "COMPLETED",
      },
    ]);
    expect(await execute({ operation: "show", targetUserId })).toMatchObject({
      playerId: target.id,
      collectedCount: 2,
      totalCopies: 8,
      used: 1,
      limit: config.boosters.daily_limit,
      remaining: config.boosters.daily_limit - 1,
      pendingTrades: 2,
    });
  });

  it("removes only the requested card and owner, failing atomically for insufficient copies", async () => {
    await give();
    await execute({
      operation: "give-card",
      targetUserId: otherUserId,
      cardId: card.id,
      quantity: 2,
    });
    const before = await snapshot();
    vi.mocked(console.info).mockClear();
    await expect(
      execute({
        operation: "remove-card",
        targetUserId,
        cardId: card.id,
        quantity: 4,
      }),
    ).rejects.toBeInstanceOf(InsufficientCopiesError);
    expect(await snapshot()).toEqual(before);
    expect(console.info).not.toHaveBeenCalled();
    await execute({
      operation: "remove-card",
      targetUserId,
      cardId: card.id,
      quantity: 3,
    });
    const after = await snapshot();
    expect(after.copies).toEqual(
      before.copies.filter(
        (c) =>
          c.ownerPlayerId ===
          before.players.find((p) => p.discordUserId === otherUserId)?.id,
      ),
    );
    expect(console.info).toHaveBeenCalledWith("Admin player mutation", {
      actorUserId: actor,
      targetUserId,
      action: "remove-card",
      cardId: card.id,
      quantity: 3,
    });
  });

  it("rejects missing cards and insufficient copies for unknown players without creating state", async () => {
    await expect(
      execute({
        operation: "remove-card",
        targetUserId,
        cardId: card.id,
        quantity: 1,
      }),
    ).rejects.toBeInstanceOf(InsufficientCopiesError);
    for (const operation of ["give-card", "remove-card"] as const)
      await expect(
        execute({
          operation,
          targetUserId,
          cardId: "00000000-0000-4000-8000-000000000099",
          quantity: 1,
        }),
      ).rejects.toBeInstanceOf(CardNotFoundError);
    expect(await db.select().from(players)).toEqual([]);
    expect(console.info).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, 1001, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid quantity %s before persistence",
    async (quantity) => {
      for (const operation of ["give-card", "remove-card"] as const)
        await expect(
          execute({ operation, targetUserId, cardId: card.id, quantity }),
        ).rejects.toBeInstanceOf(MaintenanceInputError);
      expect(await db.select().from(players)).toEqual([]);
    },
  );

  it("rejects invalid IDs before persistence", async () => {
    await expect(
      execute({ operation: "show", targetUserId: "invalid" }),
    ).rejects.toBeInstanceOf(MaintenanceInputError);
    await expect(
      execute({
        operation: "give-card",
        targetUserId,
        cardId: "invalid",
        quantity: 1,
      }),
    ).rejects.toBeInstanceOf(MaintenanceInputError);
    expect(await db.select().from(players)).toEqual([]);
  });

  it.each([
    "show",
    "give-card",
    "remove-card",
    "reset-daily",
    "simulate",
  ] as const)(
    "requires centralized authorization for %s",
    async (operation) => {
      const before = await snapshot();
      await expect(
        service.execute(otherUserId, {
          operation,
          targetUserId,
          cardId: card.id,
          quantity: 1,
          count: 1,
        } as MaintenanceRequest),
      ).rejects.toBeInstanceOf(AdminAuthorizationError);
      expect(await snapshot()).toEqual(before);
      expect(console.info).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["2026-01-10T23:00:00Z", "2026-01-11T23:00:00Z"],
    ["2026-07-10T22:00:00Z", "2026-07-11T22:00:00Z"],
    ["2026-03-28T23:00:00Z", "2026-03-29T22:00:00Z"],
    ["2026-10-24T22:00:00Z", "2026-10-25T23:00:00Z"],
  ])(
    "resets only the target's [start, end) day %s, preserving all copies including transferred ones",
    async (start, end) => {
      now = new Date(new Date(start).getTime() - 1);
      const previous = await boosters.open(targetUserId);
      now = new Date(start);
      const first = await boosters.open(targetUserId);
      const other = await boosters.open(otherUserId);
      now = new Date(new Date(end).getTime() - 1);
      const last = await boosters.open(targetUserId);
      now = new Date(end);
      const next = await boosters.open(targetUserId);
      const [recipient] = await db
        .select()
        .from(players)
        .where(eq(players.discordUserId, otherUserId));
      if (!recipient) throw new Error("Missing recipient");
      await db
        .update(cardInstances)
        .set({ ownerPlayerId: recipient.id })
        .where(eq(cardInstances.boosterOpeningId, first.id));
      now = new Date(start);
      const before = await snapshot();
      expect(
        await execute({ operation: "reset-daily", targetUserId }),
      ).toMatchObject({ clearedOpenings: 2 });
      const after = await snapshot();
      expect(after.copies).toEqual(
        before.copies.map((copy) => ({
          ...copy,
          boosterOpeningId: [first.id, last.id].includes(
            copy.boosterOpeningId ?? "",
          )
            ? null
            : copy.boosterOpeningId,
        })),
      );
      expect(after.openings.map((o) => o.id).sort()).toEqual(
        [previous.id, other.id, next.id].sort(),
      );
      expect((await boosters.status(targetUserId)).used).toBe(0);
      expect((await boosters.status(otherUserId)).used).toBe(1);
      expect(
        await execute({ operation: "reset-daily", targetUserId }),
      ).toMatchObject({ clearedOpenings: 0 });
      expect((await boosters.open(targetUserId)).status.used).toBe(1);
    },
  );

  it("rolls back links if deleting opening history fails and emits no success log", async () => {
    await boosters.open(targetUserId);
    const before = await snapshot();
    await client.exec(`CREATE FUNCTION fail_reset() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$;
      CREATE TRIGGER fail_reset BEFORE DELETE ON booster_openings FOR EACH ROW EXECUTE FUNCTION fail_reset();`);
    try {
      await expect(
        execute({ operation: "reset-daily", targetUserId }),
      ).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
      expect(console.info).not.toHaveBeenCalled();
    } finally {
      await client.exec(
        "DROP TRIGGER fail_reset ON booster_openings; DROP FUNCTION fail_reset()",
      );
    }
  });

  it("rolls back a partially executed give and lazy player creation on insert failure", async () => {
    await client.exec(`CREATE FUNCTION fail_give() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF (SELECT count(*) FROM card_instances) > 0 THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_give BEFORE INSERT ON card_instances FOR EACH ROW EXECUTE FUNCTION fail_give();`);
    try {
      await expect(give()).rejects.toThrow();
      expect(await db.select().from(cardInstances)).toEqual([]);
      expect(await db.select().from(players)).toEqual([]);
      expect(console.info).not.toHaveBeenCalled();
    } finally {
      await client.exec(
        "DROP TRIGGER fail_give ON card_instances; DROP FUNCTION fail_give()",
      );
    }
  });

  it("reads the reset day after acquiring the player lock", async () => {
    now = new Date("2026-09-10T21:59:59Z");
    await boosters.open(targetUserId);
    const delayed = new MaintenanceService(
      {
        enabledCards: () => repository.enabledCards(),
        withPlayer: (id, create, operation) =>
          repository.withPlayer(id, create, (tx) => {
            now = new Date("2026-09-10T22:00:00Z");
            return operation(tx);
          }),
      },
      config,
      service.authorize,
      () => 0,
      () => now,
    );
    expect(
      await delayed.execute(actor, { operation: "reset-daily", targetUserId }),
    ).toMatchObject({ day: "2026-09-11", clearedOpenings: 0 });
    expect(await db.select().from(boosterOpenings)).toHaveLength(1);
  });
});

describe("admin booster simulation", () => {
  it("uses the same engine and configuration, aggregating draws without any persisted changes", async () => {
    await boosters.open(targetUserId);
    const before = await snapshot();
    const lock = vi.spyOn(repository, "withPlayer");
    const catalogueRead = vi.spyOn(repository, "enabledCards");
    const result = await execute({ operation: "simulate", count: 4 });
    expect(result.kind).toBe("simulation");
    if (result.kind !== "simulation") throw new Error("Unexpected result");
    const expected = rollBooster(config, "standard", before.cards, () => 0);
    expect(result.totalCards).toBe(expected.length * 4);
    for (const rarity of rarities)
      expect(result.rarityCounts[rarity]).toBe(
        expected.filter((card) => card.rarity === rarity).length * 4,
      );
    expect(result.cards.reduce((sum, card) => sum + card.count, 0)).toBe(
      result.totalCards,
    );
    expect(
      result.cards.find((card) => card.rarity === "LEGENDARY")?.count,
    ).toBe(0);
    expect(catalogueRead).toHaveBeenCalledOnce();
    expect(lock).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
    expect(console.info).not.toHaveBeenCalled();
  });

  it("defaults to one booster and creates no player on an empty game", async () => {
    expect(await execute({ operation: "simulate" })).toMatchObject({
      count: 1,
      totalCards: 5,
    });
    expect(await db.select().from(players)).toEqual([]);
    expect(await db.select().from(boosterOpenings)).toEqual([]);
    expect(await db.select().from(cardInstances)).toEqual([]);
  });

  it.each([0, -1, 1.5, 1001, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid simulation count %s before reading",
    async (count) => {
      const read = vi.spyOn(repository, "enabledCards");
      await expect(
        execute({ operation: "simulate", count }),
      ).rejects.toBeInstanceOf(MaintenanceInputError);
      expect(read).not.toHaveBeenCalled();
    },
  );

  it("fails for incomplete enabled catalogues without changing persistence", async () => {
    await db
      .update(cards)
      .set({ enabled: false })
      .where(eq(cards.rarity, "LEGENDARY"));
    const before = await snapshot();
    await expect(execute({ operation: "simulate", count: 2 })).rejects.toThrow(
      "no enabled LEGENDARY cards",
    );
    expect(await snapshot()).toEqual(before);
  });
});
