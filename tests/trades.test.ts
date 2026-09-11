import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DrizzleTradeRepository } from "../src/db/repositories/trades.js";
import {
  cardInstances,
  players,
  tradeItems,
  trades,
} from "../src/db/schema/index.js";
import {
  TradeOwnershipError,
  TradeService,
  validateTradeOffer,
} from "../src/domain/trades/trade-service.js";
import {
  cardA,
  cardB,
  offer,
  outsiderId,
  proposer,
  proposerId,
  recipient,
  recipientId,
  seedTrades,
} from "./helpers/trades.js";

const client = new PGlite();
const db = drizzle(client);
const now = new Date("2026-09-11T12:00:00Z");
const service = new TradeService(new DrizzleTradeRepository(db), () => now);
const copies = () =>
  db.select().from(cardInstances).orderBy(asc(cardInstances.id));
beforeAll(() => migrate(db, { migrationsFolder: "src/db/migrations" }), 30_000);
beforeEach(async () => {
  await client.exec(
    "TRUNCATE card_instances, booster_openings, trade_items, trades, cards, players CASCADE",
  );
  await seedTrades(db);
});
afterAll(() => client.close());

describe("trade rules and PostgreSQL persistence", () => {
  it("aggregates repeated card UUIDs, including casing, without reserving or transferring copies", async () => {
    const before = await copies();
    const trade = await service.create(proposerId, recipientId, {
      ...offer,
      proposer: [
        { cardId: cardA.toUpperCase(), quantity: 1 },
        { cardId: cardA, quantity: 1 },
      ],
    });
    expect(trade.status).toBe("PENDING");
    expect(trade.completedAt).toBeNull();
    expect(trade.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cardId: cardA,
          quantity: 2,
          side: "PROPOSER",
        }),
      ]),
    );
    expect(await db.select().from(tradeItems)).toHaveLength(2);
    expect(await copies()).toEqual(before);
    // The same offered copies can participate in any number of pending trades.
    await expect(
      service.create(proposerId, recipientId, offer),
    ).resolves.toMatchObject({ status: "PENDING" });
    expect((await service.show(trade.id)).proposer.userId).toBe(proposerId);
  });

  it("transfers all requested quantities, including disabled cards, preserving IDs and provenance", async () => {
    const before = await copies();
    const trade = await service.create(proposerId, recipientId, offer);
    expect(await service.act(recipientId, trade.id, "accept")).toMatchObject({
      status: "COMPLETED",
      completedAt: now,
    });
    expect(await copies()).toEqual(
      before.map((copy) => ({
        ...copy,
        ownerPlayerId: copy.ownerPlayerId === proposer ? recipient : proposer,
      })),
    );
    expect(await service.show(trade.id)).toMatchObject({
      status: "COMPLETED",
      completedAt: now,
    });
    const after = await copies();
    await expect(service.act(recipientId, trade.id, "accept")).rejects.toThrow(
      "already completed",
    );
    expect(await copies()).toEqual(after);
  });

  it.each(["proposer", "recipient"] as const)(
    "revalidates a stale %s side and changes nothing",
    async (side) => {
      const trade = await service.create(proposerId, recipientId, offer);
      await db
        .delete(cardInstances)
        .where(
          eq(
            cardInstances.ownerPlayerId,
            side === "proposer" ? proposer : recipient,
          ),
        );
      const before = await copies();
      await expect(
        service.act(recipientId, trade.id, "accept"),
      ).rejects.toBeInstanceOf(TradeOwnershipError);
      expect(await copies()).toEqual(before);
      expect(await service.show(trade.id)).toMatchObject({
        status: "PENDING",
        completedAt: null,
      });
    },
  );

  it("does not let incoming copies satisfy the recipient's existing ownership requirement", async () => {
    const trade = await service.create(proposerId, recipientId, {
      ...offer,
      recipient: [{ cardId: cardA, quantity: 1 }],
    });
    const before = await copies();
    await expect(
      service.act(recipientId, trade.id, "accept"),
    ).rejects.toBeInstanceOf(TradeOwnershipError);
    expect(await copies()).toEqual(before);
  });

  it("selects original instances on both sides when both exchange the same card", async () => {
    await db.insert(cardInstances).values({
      cardId: cardA,
      ownerPlayerId: recipient,
      obtainedSource: "ADMIN",
    });
    const before = await copies();
    const trade = await service.create(proposerId, recipientId, {
      ...offer,
      recipient: [{ cardId: cardA, quantity: 1 }],
    });
    await service.act(recipientId, trade.id, "accept");
    expect(await copies()).toEqual(
      before.map((copy) => ({
        ...copy,
        ownerPlayerId:
          copy.cardId === cardA
            ? copy.ownerPlayerId === proposer
              ? recipient
              : proposer
            : copy.ownerPlayerId,
      })),
    );
  });

  it("validates offered ownership at creation but only checks requested ownership on acceptance", async () => {
    await expect(
      service.create(proposerId, recipientId, {
        ...offer,
        proposer: [{ cardId: cardA, quantity: 3 }],
      }),
    ).rejects.toThrow("do not own");
    expect(await db.select().from(trades)).toEqual([]);
    await expect(
      service.create(proposerId, recipientId, {
        ...offer,
        recipient: [{ cardId: cardB, quantity: 2 }],
      }),
    ).resolves.toMatchObject({ status: "PENDING" });
  });

  it("supports an empty side, lazily creates a recipient, and keeps exact string snowflakes", async () => {
    const trade = await service.create(proposerId, outsiderId, {
      ...offer,
      recipient: [],
    });
    expect(trade.recipient.userId).toBe(outsiderId);
    await service.act(outsiderId, trade.id, "accept");
    expect(await db.select().from(players)).toHaveLength(3);
  });

  it.each(["accept", "reject", "cancel"] as const)(
    "enforces %s permissions without changing state",
    async (action) => {
      const trade = await service.create(proposerId, recipientId, offer);
      const before = await copies();
      for (const actor of [
        outsiderId,
        action === "cancel" ? recipientId : proposerId,
      ])
        await expect(service.act(actor, trade.id, action)).rejects.toThrow(
          "Only the",
        );
      expect(await copies()).toEqual(before);
      expect((await service.show(trade.id)).status).toBe("PENDING");
    },
  );

  it.each(["reject", "cancel"] as const)(
    "allows authorized %s and prevents later changes",
    async (action) => {
      const trade = await service.create(proposerId, recipientId, offer);
      const before = await copies();
      const status = action === "reject" ? "REJECTED" : "CANCELLED";
      expect(
        await service.act(
          action === "reject" ? recipientId : proposerId,
          trade.id,
          action,
        ),
      ).toMatchObject({ status, completedAt: null });
      for (const next of ["accept", "reject", "cancel"] as const)
        await expect(
          service.act(
            next === "cancel" ? proposerId : recipientId,
            trade.id,
            next,
          ),
        ).rejects.toThrow("already");
      expect(await copies()).toEqual(before);
    },
  );

  it.each(["second transfer", "completion"])(
    "rolls back all ownership and status after failure during %s",
    async (stage) => {
      const trade = await service.create(proposerId, recipientId, offer);
      const before = await copies();
      const table = stage === "completion" ? "trades" : "card_instances";
      const condition =
        stage === "completion"
          ? "NEW.status = 'COMPLETED'"
          : `NEW.card_id = '${cardB}'`;
      await client.exec(
        `CREATE FUNCTION fail_trade() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_trade BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_trade();`,
      );
      try {
        await expect(
          service.act(recipientId, trade.id, "accept"),
        ).rejects.toThrow();
        expect(await copies()).toEqual(before);
        expect(await service.show(trade.id)).toMatchObject({
          status: "PENDING",
          completedAt: null,
        });
      } finally {
        await client.exec(
          `DROP TRIGGER fail_trade ON ${table}; DROP FUNCTION fail_trade()`,
        );
      }
      await expect(
        service.act(recipientId, trade.id, "accept"),
      ).resolves.toMatchObject({ status: "COMPLETED" });
    },
  );

  it("rejects self-trades, unknown cards, and malformed inputs before leaving any proposal", async () => {
    await expect(service.create(proposerId, proposerId, offer)).rejects.toThrow(
      "yourself",
    );
    await expect(service.create("bad", recipientId, offer)).rejects.toThrow(
      "player ID",
    );
    await expect(
      service.create(proposerId, recipientId, {
        ...offer,
        recipient: [{ cardId: randomUUID(), quantity: 1 }],
      }),
    ).rejects.toThrow("not found");
    expect(await db.select().from(trades)).toEqual([]);
    expect(await db.select().from(tradeItems)).toEqual([]);
    await expect(service.show(randomUUID())).rejects.toThrow("not found");
    await expect(
      service.act(recipientId, randomUUID(), "accept"),
    ).rejects.toThrow("not found");
    await expect(service.show("bad")).rejects.toThrow("UUID");
  });
});

describe("trade input validation without persistence", () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    "rejects quantity %s",
    (quantity) => {
      expect(() =>
        validateTradeOffer({
          ...offer,
          proposer: [{ cardId: cardA, quantity }],
        }),
      ).toThrow();
    },
  );
  it("rejects an empty trade, invalid UUIDs and duplicate quantity overflow", () => {
    expect(() => validateTradeOffer({ proposer: [], recipient: [] })).toThrow(
      "at least one",
    );
    expect(() =>
      validateTradeOffer({
        ...offer,
        proposer: [{ cardId: "bad", quantity: 1 }],
      }),
    ).toThrow("Use valid cards");
    expect(() =>
      validateTradeOffer({
        ...offer,
        proposer: [
          { cardId: cardA, quantity: 2_147_483_647 },
          { cardId: cardA, quantity: 1 },
        ],
      }),
    ).toThrow("too large");
  });
});
