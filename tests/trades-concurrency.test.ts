import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { asc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DrizzleTradeRepository } from "../src/db/repositories/trades.js";
import { cardInstances, trades } from "../src/db/schema/index.js";
import {
  TradeError,
  TradeOwnershipError,
  TradeService,
} from "../src/domain/trades/trade-service.js";
import {
  cardA,
  offer,
  proposer,
  proposerId,
  recipient,
  recipientId,
  seedTrades,
} from "./helpers/trades.js";

// A real server is required: PGlite serializes transactions on one connection.
const connectionString = process.env.TEST_DATABASE_URL;
describe.skipIf(!connectionString)(
  "trade concurrency on a PostgreSQL server",
  () => {
    const database = `trade_test_${randomUUID().replaceAll("-", "")}`;
    const testUrl = new URL(
      connectionString ?? "postgresql://localhost/postgres",
    );
    testUrl.pathname = `/${database}`;
    const admin = new pg.Pool({ connectionString });
    const pool = new pg.Pool({
      connectionString: testUrl.toString(),
      max: 12,
      options: "-c statement_timeout=10000",
      application_name: database,
    });
    const db = drizzle(pool);
    const service = new TradeService(new DrizzleTradeRepository(db));
    let created = false;
    beforeAll(async () => {
      await admin.query(`CREATE DATABASE "${database}"`);
      created = true;
      await migrate(db, { migrationsFolder: "src/db/migrations" });
    }, 30_000);
    beforeEach(async () => {
      await pool.query(
        "TRUNCATE card_instances, booster_openings, trade_items, trades, cards, players CASCADE",
      );
      await seedTrades(db);
    });
    afterAll(async () => {
      try {
        await pool.end();
        if (created) await admin.query(`DROP DATABASE "${database}"`);
      } finally {
        await admin.end();
      }
    });

    async function blockedOnPlayer(attempts: () => Promise<unknown>[]) {
      const holder = await pool.connect();
      let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
      try {
        await holder.query("BEGIN");
        // recipient UUID sorts first, even when it is not the acting player.
        await holder.query("SELECT id FROM players WHERE id = $1 FOR UPDATE", [
          recipient,
        ]);
        const jobs = attempts();
        pending = Promise.allSettled(jobs);
        const deadline = Date.now() + 5000;
        let waiting = 0;
        while (Date.now() < deadline) {
          const result = await pool.query<{ count: string }>(
            "SELECT count(*) FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'",
            [database],
          );
          waiting = Number(result.rows[0]?.count);
          if (waiting === jobs.length) break;
          await setTimeout(20);
        }
        expect(waiting, "all actions must wait on the player-row lock").toBe(
          jobs.length,
        );
        // A waiter must not have locked the higher UUID before waiting on the
        // lower one, including implicit foreign-key locks during creation.
        await holder.query(
          "SELECT id FROM players WHERE id = $1 FOR UPDATE NOWAIT",
          [proposer],
        );
        await holder.query("COMMIT");
        return await pending;
      } finally {
        await holder.query("ROLLBACK");
        holder.release();
        await pending;
      }
    }

    it("blocks simultaneous accepts and completes exactly once after reloading the trade", async () => {
      const trade = await service.create(proposerId, recipientId, offer);
      const before = await db
        .select()
        .from(cardInstances)
        .orderBy(asc(cardInstances.id));
      const results = await blockedOnPlayer(() =>
        Array.from({ length: 4 }, () =>
          service.act(recipientId, trade.id, "accept"),
        ),
      );
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      for (const result of results)
        if (result.status === "rejected")
          expect(result.reason).toMatchObject({
            message: "This trade is already completed.",
          });
      expect(
        await db.select().from(cardInstances).orderBy(asc(cardInstances.id)),
      ).toEqual(
        before.map((copy) => ({
          ...copy,
          ownerPlayerId: copy.ownerPlayerId === proposer ? recipient : proposer,
        })),
      );
      expect((await service.show(trade.id)).status).toBe("COMPLETED");
    }, 20_000);

    it("allows only one overlapping trade to consume the available copies", async () => {
      const first = await service.create(proposerId, recipientId, offer);
      const second = await service.create(proposerId, recipientId, offer);
      const results = await blockedOnPlayer(() =>
        [first, second].map((trade) =>
          service.act(recipientId, trade.id, "accept"),
        ),
      );
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const failure = results.find((result) => result.status === "rejected");
      expect(failure?.reason).toBeInstanceOf(TradeOwnershipError);
      expect(
        (await db.select().from(trades)).map((trade) => trade.status).sort(),
      ).toEqual(["COMPLETED", "PENDING"]);
      expect(await db.select().from(cardInstances)).toHaveLength(3);
    }, 20_000);

    it("uses deterministic player order for reciprocal trades without deadlock", async () => {
      await db.insert(cardInstances).values(
        Array.from({ length: 2 }, () => ({
          cardId: cardA,
          ownerPlayerId: recipient,
          obtainedSource: "ADMIN" as const,
        })),
      );
      const sameCard = { proposer: offer.proposer, recipient: offer.proposer };
      const first = await service.create(proposerId, recipientId, sameCard);
      const second = await service.create(recipientId, proposerId, sameCard);
      const results = await blockedOnPlayer(() => [
        service.act(recipientId, first.id, "accept"),
        service.act(proposerId, second.id, "accept"),
      ]);
      expect(results.every((result) => result.status === "fulfilled")).toBe(
        true,
      );
      expect(
        (await db.select().from(trades)).every(
          (trade) => trade.status === "COMPLETED",
        ),
      ).toBe(true);
    }, 20_000);

    it.each(["cancel", "reject"] as const)(
      "serializes acceptance against %s with one terminal outcome",
      async (action) => {
        const trade = await service.create(proposerId, recipientId, offer);
        const before = await db
          .select()
          .from(cardInstances)
          .orderBy(asc(cardInstances.id));
        const results = await blockedOnPlayer(() => [
          service.act(recipientId, trade.id, "accept"),
          service.act(
            action === "cancel" ? proposerId : recipientId,
            trade.id,
            action,
          ),
        ]);
        expect(
          results.filter((result) => result.status === "fulfilled"),
        ).toHaveLength(1);
        expect(
          results.find((result) => result.status === "rejected")?.reason,
        ).toBeInstanceOf(TradeError);
        const completed = (await service.show(trade.id)).status === "COMPLETED";
        expect(
          await db.select().from(cardInstances).orderBy(asc(cardInstances.id)),
        ).toEqual(
          completed
            ? before.map((copy) => ({
                ...copy,
                ownerPlayerId:
                  copy.ownerPlayerId === proposer ? recipient : proposer,
              }))
            : before,
        );
      },
      20_000,
    );

    it("orders creation's foreign-key locks with concurrent acceptance", async () => {
      const trade = await service.create(proposerId, recipientId, offer);
      const results = await blockedOnPlayer(() => [
        service.create(proposerId, recipientId, offer),
        service.act(recipientId, trade.id, "accept"),
      ]);
      expect(results[1]?.status).toBe("fulfilled");
      // If acceptance wins, creation must re-read the now unavailable offer.
      if (results[0]?.status === "rejected")
        expect(results[0].reason).toMatchObject({
          message: "You do not own the quantities you are offering.",
        });
      expect((await service.show(trade.id)).status).toBe("COMPLETED");
    }, 20_000);

    it("creates pending offers while matching instances are locked elsewhere", async () => {
      const holder = await pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT id FROM card_instances FOR UPDATE");
        await expect(
          service.create(proposerId, recipientId, offer),
        ).resolves.toMatchObject({ status: "PENDING" });
      } finally {
        await holder.query("ROLLBACK");
        holder.release();
      }
    }, 20_000);

    it("rolls back ownership after a completion-write failure on the server", async () => {
      const trade = await service.create(proposerId, recipientId, offer);
      const before = await db
        .select()
        .from(cardInstances)
        .orderBy(asc(cardInstances.id));
      await pool.query(
        "CREATE FUNCTION fail_trade() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$; CREATE TRIGGER fail_trade BEFORE UPDATE ON trades FOR EACH ROW EXECUTE FUNCTION fail_trade()",
      );
      try {
        await expect(
          service.act(recipientId, trade.id, "accept"),
        ).rejects.toThrow();
        expect(
          await db.select().from(cardInstances).orderBy(asc(cardInstances.id)),
        ).toEqual(before);
        expect(await service.show(trade.id)).toMatchObject({
          status: "PENDING",
          completedAt: null,
        });
      } finally {
        await pool.query(
          "DROP TRIGGER fail_trade ON trades; DROP FUNCTION fail_trade()",
        );
      }
    });
  },
);
