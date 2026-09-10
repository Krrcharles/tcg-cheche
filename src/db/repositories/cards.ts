import { asc, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { Card, CardRepository } from "../../domain/cards/card.js";
import { cards } from "../schema/index.js";

export class DrizzleCardRepository implements CardRepository {
  constructor(
    private readonly db: Pick<
      PgDatabase<PgQueryResultHKT>,
      "select" | "insert" | "update"
    >,
  ) {}

  async create(
    card: Pick<Card, "id" | "name" | "rarity" | "assetKey">,
  ): Promise<Card> {
    const [created] = await this.db.insert(cards).values(card).returning();
    if (!created) throw new Error("Card insert returned no record.");
    return created;
  }

  async find(id: string) {
    const [card] = await this.db.select().from(cards).where(eq(cards.id, id));
    return card;
  }

  async list(offset: number, limit: number) {
    return this.db
      .select()
      .from(cards)
      .orderBy(asc(cards.name), asc(cards.id))
      .offset(offset)
      .limit(limit);
  }

  async update(
    id: string,
    changes: Partial<Pick<Card, "name" | "rarity" | "enabled">>,
  ) {
    const [card] = await this.db
      .update(cards)
      .set({ ...changes, updatedAt: new Date() })
      .where(eq(cards.id, id))
      .returning();
    return card;
  }
}
