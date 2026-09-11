import { and, asc, eq, inArray } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import {
  type Trade,
  TradeError,
  type TradePlayer,
  type TradeRepository,
  type TradeTransaction,
} from "../../domain/trades/trade-service.js";
import {
  cardInstances,
  cards,
  players,
  tradeItems,
  trades,
} from "../schema/index.js";

type Database = PgDatabase<PgQueryResultHKT>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Reader = Pick<Database, "select">;

async function readTrade(
  db: Reader,
  row: typeof trades.$inferSelect,
): Promise<Trade> {
  const participants = await db
    .select()
    .from(players)
    .where(inArray(players.id, [row.proposerPlayerId, row.recipientPlayerId]));
  const player = (id: string): TradePlayer => {
    const record = participants.find((player) => player.id === id);
    if (!record) throw new Error("Trade player not found.");
    return { id, userId: record.discordUserId };
  };
  const items = await db
    .select({
      side: tradeItems.side,
      cardId: tradeItems.cardId,
      quantity: tradeItems.quantity,
      name: cards.name,
      rarity: cards.rarity,
    })
    .from(tradeItems)
    .innerJoin(cards, eq(cards.id, tradeItems.cardId))
    .where(eq(tradeItems.tradeId, row.id))
    .orderBy(asc(tradeItems.side), asc(tradeItems.cardId));
  return {
    id: row.id,
    proposer: player(row.proposerPlayerId),
    recipient: player(row.recipientPlayerId),
    items,
    status: row.status,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}

function context(
  tx: Transaction,
  proposer: TradePlayer,
  recipient: TradePlayer,
): TradeTransaction {
  return {
    proposer,
    recipient,
    describe: async (offer) => {
      const entries = [
        ...offer.proposer.map((item) => ({
          ...item,
          side: "PROPOSER" as const,
        })),
        ...offer.recipient.map((item) => ({
          ...item,
          side: "RECIPIENT" as const,
        })),
      ];
      const catalogue = await tx
        .select()
        .from(cards)
        .where(
          inArray(
            cards.id,
            entries.map((item) => item.cardId),
          ),
        );
      return entries.map((item) => {
        const card = catalogue.find((card) => card.id === item.cardId);
        if (!card) throw new TradeError("Card not found.");
        return { ...item, name: card.name, rarity: card.rarity };
      });
    },
    copies: async (playerId, item, lock) => {
      const query = tx
        .select({ id: cardInstances.id })
        .from(cardInstances)
        .where(
          and(
            eq(cardInstances.ownerPlayerId, playerId),
            eq(cardInstances.cardId, item.cardId),
          ),
        )
        .orderBy(asc(cardInstances.id))
        .limit(item.quantity);
      const rows = await (lock ? query.for("update") : query);
      return rows.map((row) => row.id);
    },
    insert: async (id, items) => {
      const [row] = await tx
        .insert(trades)
        .values({
          id,
          proposerPlayerId: proposer.id,
          recipientPlayerId: recipient.id,
          status: "PENDING",
        })
        .returning();
      if (!row) throw new Error("Trade insert returned no record.");
      await tx.insert(tradeItems).values(
        items.map(({ side, cardId, quantity }) => ({
          tradeId: id,
          side,
          cardId,
          quantity,
        })),
      );
      return {
        id,
        proposer,
        recipient,
        items,
        status: row.status,
        createdAt: row.createdAt,
        completedAt: row.completedAt,
      };
    },
    transfer: async (ids, ownerId) => {
      await tx
        .update(cardInstances)
        .set({ ownerPlayerId: ownerId })
        .where(inArray(cardInstances.id, ids));
    },
    transition: async (trade, status, completedAt) => {
      await tx
        .update(trades)
        .set({ status, completedAt })
        .where(eq(trades.id, trade.id));
      return { ...trade, status, completedAt };
    },
  };
}

export class DrizzleTradeRepository implements TradeRepository {
  constructor(private readonly db: Pick<Database, "transaction" | "select">) {}

  async find(id: string) {
    const [row] = await this.db.select().from(trades).where(eq(trades.id, id));
    return row ? readTrade(this.db, row) : undefined;
  }

  withParticipants<T>(
    proposerId: string,
    recipientId: string,
    operation: (tx: TradeTransaction) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(
      async (tx) => {
        // Stable insertion order also handles simultaneous first-ever reciprocal offers.
        for (const discordUserId of [proposerId, recipientId].sort())
          await tx
            .insert(players)
            .values({ discordUserId })
            .onConflictDoNothing({ target: players.discordUserId });
        const rows = await tx
          .select()
          .from(players)
          .where(inArray(players.discordUserId, [proposerId, recipientId]))
          .orderBy(asc(players.id))
          // The trade's foreign keys acquire KEY SHARE locks anyway. Take them
          // in UUID order so creation cannot deadlock against an acceptance.
          .for("key share");
        const player = (userId: string) => {
          const row = rows.find((row) => row.discordUserId === userId);
          if (!row) throw new Error("Player lookup returned no record.");
          return { id: row.id, userId };
        };
        // Creation only reads ownership; no card-instance locks or reservations.
        return operation(context(tx, player(proposerId), player(recipientId)));
      },
      { isolationLevel: "read committed" },
    );
  }

  withTrade<T>(
    id: string,
    operation: (tx: TradeTransaction, trade: Trade) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(
      async (tx) => {
        const [initial] = await tx
          .select()
          .from(trades)
          .where(eq(trades.id, id));
        if (!initial) throw new TradeError("Trade not found.");
        // Every action shares the player -> trade -> instance lock order. Player
        // UUID ordering also serializes reciprocal trades and admin removals.
        await tx
          .select({ id: players.id })
          .from(players)
          .where(
            inArray(players.id, [
              initial.proposerPlayerId,
              initial.recipientPlayerId,
            ]),
          )
          .orderBy(asc(players.id))
          .for("update");
        const [row] = await tx
          .select()
          .from(trades)
          .where(eq(trades.id, id))
          .for("update");
        if (!row) throw new TradeError("Trade not found.");
        const trade = await readTrade(tx, row);
        return operation(context(tx, trade.proposer, trade.recipient), trade);
      },
      { isolationLevel: "read committed" },
    );
  }
}
