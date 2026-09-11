import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { cardInstances, cards, players } from "../../src/db/schema/index.js";

export const proposerId = "987654321098765432";
export const recipientId = "987654321098765433";
export const outsiderId = "987654321098765434";
// Proposer sorts after recipient, exercising UUID order rather than side order.
export const proposer = "00000000-0000-4000-8000-000000000002";
export const recipient = "00000000-0000-4000-8000-000000000001";
export const cardA = "00000000-0000-4000-8000-000000000010";
export const cardB = "00000000-0000-4000-8000-000000000011";
export const offer = {
  proposer: [{ cardId: cardA, quantity: 2 }],
  recipient: [{ cardId: cardB, quantity: 1 }],
};

export async function seedTrades(
  db: Pick<PgDatabase<PgQueryResultHKT>, "insert">,
) {
  await db.insert(players).values([
    { id: proposer, discordUserId: proposerId },
    { id: recipient, discordUserId: recipientId },
  ]);
  await db.insert(cards).values([
    {
      id: cardA,
      name: "Card A",
      rarity: "COMMON",
      assetKey: "cards/a",
      enabled: false,
    },
    { id: cardB, name: "Card B", rarity: "RARE", assetKey: "cards/b" },
  ]);
  await db.insert(cardInstances).values([
    ...Array.from({ length: 2 }, () => ({
      cardId: cardA,
      ownerPlayerId: proposer,
      obtainedSource: "ADMIN" as const,
    })),
    { cardId: cardB, ownerPlayerId: recipient, obtainedSource: "ADMIN" },
  ]);
}
