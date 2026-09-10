import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadGameConfiguration } from "../src/config/game.js";
import { DrizzleBoosterRepository } from "../src/db/repositories/boosters.js";
import { DrizzleMaintenanceRepository } from "../src/db/repositories/maintenance.js";
import {
  boosterOpenings,
  cardInstances,
  cards,
  players,
} from "../src/db/schema/index.js";
import { createAdminGuard } from "../src/domain/administration/admin-guard.js";
import {
  InsufficientCopiesError,
  MaintenanceService,
} from "../src/domain/administration/maintenance-service.js";
import {
  BoosterQuotaError,
  BoosterService,
} from "../src/domain/boosters/booster-service.js";
import { rarities } from "../src/domain/cards/card.js";

// PGlite serializes transactions on one connection; only a real server can
// demonstrate player-row locking across independent concurrent connections.
const connectionString = process.env.TEST_DATABASE_URL;
describe.skipIf(!connectionString)(
  "booster concurrency on a PostgreSQL server",
  () => {
    const database = `booster_test_${randomUUID().replaceAll("-", "")}`;
    const testUrl = new URL(
      connectionString ?? "postgresql://localhost/postgres",
    );
    testUrl.pathname = `/${database}`;
    const admin = new pg.Pool({ connectionString });
    let created = false;
    const pool = new pg.Pool({
      connectionString: testUrl.toString(),
      max: 12,
      options: "-c statement_timeout=10000",
      application_name: database,
    });
    const db = drizzle(pool);
    const config = loadGameConfiguration();
    const service = new BoosterService(
      new DrizzleBoosterRepository(db),
      config,
      () => 0,
    );
    const user = "987654321098765432";
    const maintenance = new MaintenanceService(
      new DrizzleMaintenanceRepository(db),
      config,
      createAdminGuard({ user_ids: [user], role_ids: [] }),
    );

    beforeAll(async () => {
      await admin.query(`CREATE DATABASE "${database}"`);
      created = true;
      await migrate(db, {
        migrationsFolder: "src/db/migrations",
      });
    }, 30_000);
    beforeEach(async () => {
      await pool.query(
        "TRUNCATE card_instances, booster_openings, players, cards CASCADE",
      );
      await db.insert(cards).values(
        rarities.map((rarity) => ({
          name: rarity,
          rarity,
          assetKey: `cards/${rarity}`,
        })),
      );
    });
    afterAll(async () => {
      try {
        await pool.end();
        if (created) await admin.query(`DROP DATABASE "${database}"`);
      } finally {
        await admin.end();
      }
    });

    async function assertResults(
      attempts: PromiseSettledResult<unknown>[],
      expectedSuccesses: number,
    ) {
      expect(
        attempts.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(expectedSuccesses);
      const failures = attempts.filter(
        (result) => result.status === "rejected",
      );
      expect(failures).toHaveLength(attempts.length - expectedSuccesses);
      for (const failure of failures)
        expect(failure.reason).toBeInstanceOf(BoosterQuotaError);
      expect(await db.select().from(players)).toHaveLength(1);
      expect(await db.select().from(boosterOpenings)).toHaveLength(
        config.boosters.daily_limit,
      );
      expect(await db.select().from(cardInstances)).toHaveLength(
        config.boosters.daily_limit * 5,
      );
    }

    it("handles concurrent first-ever opens without duplicate players or excess quota", async () => {
      const attempts = await Promise.allSettled(
        Array.from({ length: 8 }, () => service.open(user)),
      );
      await assertResults(attempts, config.boosters.daily_limit);
    }, 20_000);

    it("serializes competing removals so only one can consume the available copies", async () => {
      const opening = await service.open(user);
      const card = opening.cards[0];
      if (!card) throw new Error("Missing card");
      const attempts = await Promise.allSettled(
        Array.from({ length: 2 }, () =>
          maintenance.execute(user, {
            operation: "remove-card",
            targetUserId: user,
            cardId: card.id,
            quantity: 3,
          }),
        ),
      );
      expect(
        attempts.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const failure = attempts.find((result) => result.status === "rejected");
      expect(failure?.reason).toBeInstanceOf(InsufficientCopiesError);
      expect(await db.select().from(cardInstances)).toHaveLength(2);
    }, 20_000);

    it("blocks reset and removal on the same player row used by booster openings", async () => {
      const opening = await service.open(user);
      const card = opening.cards[0];
      if (!card) throw new Error("Missing card");
      const holder = await pool.connect();
      let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
      try {
        await holder.query("BEGIN");
        await holder.query(
          "SELECT id FROM players WHERE discord_user_id = $1 FOR UPDATE",
          [user],
        );
        pending = Promise.allSettled([
          maintenance.execute(user, {
            operation: "reset-daily",
            targetUserId: user,
          }),
          maintenance.execute(user, {
            operation: "remove-card",
            targetUserId: user,
            cardId: card.id,
            quantity: 2,
          }),
        ]);
        const deadline = Date.now() + 5000;
        let waiting = 0;
        while (Date.now() < deadline) {
          const result = await pool.query<{ count: string }>(
            "SELECT count(*) FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'",
            [database],
          );
          waiting = Number(result.rows[0]?.count);
          if (waiting === 2) break;
          await setTimeout(20);
        }
        expect(
          waiting,
          "both admin mutations must wait for the player-row lock",
        ).toBe(2);
        await holder.query("COMMIT");
        expect(
          (await pending).every((result) => result.status === "fulfilled"),
        ).toBe(true);
        expect(await db.select().from(boosterOpenings)).toEqual([]);
        const copies = await db.select().from(cardInstances);
        expect(copies).toHaveLength(3);
        expect(copies.every((copy) => copy.boosterOpeningId === null)).toBe(
          true,
        );
        expect((await service.open(user)).status.used).toBe(1);
      } finally {
        await holder.query("ROLLBACK");
        holder.release();
        await pending;
      }
    }, 20_000);

    it("blocks competing opens on the player row and permits only the last remaining opening", async () => {
      for (let i = 1; i < config.boosters.daily_limit; i++)
        await service.open(user);
      const holder = await pool.connect();
      let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
      try {
        await holder.query("BEGIN");
        await holder.query(
          "SELECT id FROM players WHERE discord_user_id = $1 FOR UPDATE",
          [user],
        );
        pending = Promise.allSettled(
          Array.from({ length: 4 }, () => service.open(user)),
        );
        const deadline = Date.now() + 5000;
        let waiting = 0;
        while (Date.now() < deadline) {
          const result = await pool.query<{ count: string }>(
            "SELECT count(*) FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'",
            [database],
          );
          waiting = Number(result.rows[0]?.count);
          if (waiting === 4) break;
          await setTimeout(20);
        }
        expect(
          waiting,
          "all competing transactions must wait for the player-row lock",
        ).toBe(4);
        await holder.query("COMMIT");
        await assertResults(await pending, 1);
      } finally {
        await holder.query("ROLLBACK");
        holder.release();
        await pending;
      }
    }, 20_000);
  },
);
