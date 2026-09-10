import { and, count, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { CollectionRepository } from "../../domain/collections/collection-service.js";
import { cardInstances, cards, players } from "../schema/index.js";

export class DrizzleCollectionRepository implements CollectionRepository {
  constructor(
    private readonly db: Pick<PgDatabase<PgQueryResultHKT>, "select">,
  ) {}

  private query(userId: string) {
    const owner = this.db
      .select({ id: players.id })
      .from(players)
      .where(eq(players.discordUserId, userId));
    return this.db
      .select({
        cardId: cards.id,
        name: cards.name,
        rarity: cards.rarity,
        assetKey: cards.assetKey,
        ownedCount: count(cardInstances.id),
      })
      .from(cards)
      .leftJoin(
        cardInstances,
        and(
          eq(cardInstances.cardId, cards.id),
          eq(cardInstances.ownerPlayerId, owner),
        ),
      )
      .groupBy(cards.id);
  }

  async collection(userId: string) {
    // One statement gives completion and ownership a consistent snapshot.
    // Disabled cards remain part of the catalogue and existing collections.
    const rows = await this.query(userId);
    return {
      entries: rows.filter((row) => row.ownedCount > 0),
      catalogueCount: rows.length,
    };
  }

  async card(userId: string, cardId: string) {
    const [card] = await this.query(userId).where(eq(cards.id, cardId));
    return card;
  }
}
