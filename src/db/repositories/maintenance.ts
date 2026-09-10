import {
  and,
  asc,
  count,
  countDistinct,
  eq,
  gte,
  inArray,
  lt,
  or,
  sql,
} from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import {
  InsufficientCopiesError,
  type MaintenanceRepository,
  type MaintenanceTransaction,
} from "../../domain/administration/maintenance-service.js";
import type { GameDay } from "../../domain/boosters/game-day.js";
import { CardNotFoundError } from "../../domain/cards/card-service.js";
import {
  boosterOpenings,
  cardInstances,
  cards,
  players,
  trades,
} from "../schema/index.js";

export class DrizzleMaintenanceRepository implements MaintenanceRepository {
  constructor(
    private readonly db: Pick<
      PgDatabase<PgQueryResultHKT>,
      "transaction" | "select"
    >,
  ) {}

  enabledCards() {
    return this.db
      .select()
      .from(cards)
      .where(eq(cards.enabled, true))
      .orderBy(asc(cards.id));
  }

  withPlayer<T>(
    discordUserId: string,
    create: boolean,
    operation: (transaction: MaintenanceTransaction) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(
      async (tx) => {
        if (create)
          await tx
            .insert(players)
            .values({ discordUserId })
            .onConflictDoNothing({ target: players.discordUserId });
        const [player] = await tx
          .select()
          .from(players)
          .where(eq(players.discordUserId, discordUserId))
          .for("update");
        const currentDay = (day: GameDay) => {
          if (!player) throw new Error("Player lookup returned no record.");
          return and(
            eq(boosterOpenings.playerId, player.id),
            gte(
              boosterOpenings.openedAt,
              sql`(${day.date}::timestamp AT TIME ZONE ${day.timezone})`,
            ),
            lt(
              boosterOpenings.openedAt,
              sql`(${day.nextDate}::timestamp AT TIME ZONE ${day.timezone})`,
            ),
          );
        };
        async function requireCard(cardId: string) {
          const [card] = await tx
            .select({ id: cards.id })
            .from(cards)
            .where(eq(cards.id, cardId));
          if (!card) throw new CardNotFoundError();
        }
        return operation({
          show: async (day) => {
            if (!player)
              return {
                playerId: null,
                collectedCount: 0,
                totalCopies: 0,
                used: 0,
                pendingTrades: 0,
              };
            const [collection] = await tx
              .select({
                collectedCount: countDistinct(cardInstances.cardId),
                totalCopies: count(),
              })
              .from(cardInstances)
              .where(eq(cardInstances.ownerPlayerId, player.id));
            const [usage] = await tx
              .select({ used: count() })
              .from(boosterOpenings)
              .where(currentDay(day));
            const [pending] = await tx
              .select({ pendingTrades: count() })
              .from(trades)
              .where(
                and(
                  eq(trades.status, "PENDING"),
                  or(
                    eq(trades.proposerPlayerId, player.id),
                    eq(trades.recipientPlayerId, player.id),
                  ),
                ),
              );
            if (!collection || !usage || !pending)
              throw new Error("Player summary query returned no record.");
            return { playerId: player.id, ...collection, ...usage, ...pending };
          },
          give: async (cardId, quantity, obtainedAt) => {
            await requireCard(cardId);
            if (!player) throw new Error("Player lookup returned no record.");
            await tx.insert(cardInstances).values(
              Array.from({ length: quantity }, () => ({
                cardId,
                ownerPlayerId: player.id,
                obtainedAt,
                obtainedSource: "ADMIN" as const,
              })),
            );
          },
          remove: async (cardId, quantity) => {
            await requireCard(cardId);
            if (!player) throw new InsufficientCopiesError();
            const copies = await tx
              .select({ id: cardInstances.id })
              .from(cardInstances)
              .where(
                and(
                  eq(cardInstances.ownerPlayerId, player.id),
                  eq(cardInstances.cardId, cardId),
                ),
              )
              .orderBy(asc(cardInstances.id))
              .limit(quantity)
              .for("update");
            if (copies.length < quantity) throw new InsufficientCopiesError();
            await tx.delete(cardInstances).where(
              inArray(
                cardInstances.id,
                copies.map((copy) => copy.id),
              ),
            );
          },
          resetDaily: async (day) => {
            if (!player) return 0;
            const openings = tx
              .select({ id: boosterOpenings.id })
              .from(boosterOpenings)
              .where(currentDay(day));
            // Preserve every copy, including copies already transferred to another
            // player. Only the link to the intentionally cleared history is lost.
            await tx
              .update(cardInstances)
              .set({ boosterOpeningId: null })
              .where(inArray(cardInstances.boosterOpeningId, openings));
            const deleted = await tx
              .delete(boosterOpenings)
              .where(currentDay(day))
              .returning({ id: boosterOpenings.id });
            return deleted.length;
          },
        });
      },
      { isolationLevel: "read committed" },
    );
  }
}
