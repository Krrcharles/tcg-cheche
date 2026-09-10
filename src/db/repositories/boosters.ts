import { and, asc, count, eq, gte, lt, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type {
  BoosterRepository,
  BoosterTransaction,
} from "../../domain/boosters/booster-service.js";
import {
  boosterOpenings,
  cardInstances,
  cards,
  players,
} from "../schema/index.js";

export class DrizzleBoosterRepository implements BoosterRepository {
  constructor(
    private readonly db: Pick<PgDatabase<PgQueryResultHKT>, "transaction">,
  ) {}

  withPlayer<T>(
    discordUserId: string,
    operation: (transaction: BoosterTransaction) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(
      async (tx) => {
        await tx.insert(players).values({ discordUserId }).onConflictDoNothing({
          target: players.discordUserId,
        });
        const [player] = await tx
          .select()
          .from(players)
          .where(eq(players.discordUserId, discordUserId))
          .for("update");
        if (!player) throw new Error("Player lookup returned no record.");
        return operation({
          usage: async (day) => {
            // Convert each local midnight independently: DST days are not 24 hours.
            const start = sql`(${day.date}::timestamp AT TIME ZONE ${day.timezone})`;
            const end = sql`(${day.nextDate}::timestamp AT TIME ZONE ${day.timezone})`;
            const [usage] = await tx
              .select({
                used: count(),
                resetsAt: sql`${end}`.mapWith(
                  (value: string) => new Date(value),
                ),
              })
              .from(boosterOpenings)
              .where(
                and(
                  eq(boosterOpenings.playerId, player.id),
                  gte(boosterOpenings.openedAt, start),
                  lt(boosterOpenings.openedAt, end),
                ),
              );
            if (!usage) throw new Error("Quota query returned no record.");
            return usage;
          },
          enabledCards: () =>
            tx
              .select()
              .from(cards)
              .where(eq(cards.enabled, true))
              .orderBy(asc(cards.id)),
          save: async (selected, openedAt) => {
            const [opening] = await tx
              .insert(boosterOpenings)
              .values({
                playerId: player.id,
                openedAt,
              })
              .returning();
            if (!opening) throw new Error("Opening insert returned no record.");
            await tx.insert(cardInstances).values(
              selected.map((card) => ({
                cardId: card.id,
                ownerPlayerId: player.id,
                obtainedAt: openedAt,
                obtainedSource: "BOOSTER" as const,
                boosterOpeningId: opening.id,
              })),
            );
            return opening.id;
          },
        });
      },
      { isolationLevel: "read committed" },
    );
  }
}
