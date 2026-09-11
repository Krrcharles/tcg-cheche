import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Rarity } from "../cards/card.js";

export type TradeStatus = "PENDING" | "COMPLETED" | "REJECTED" | "CANCELLED";
export type TradeAction = "accept" | "reject" | "cancel";
export interface TradeQuantity {
  cardId: string;
  quantity: number;
}
export interface TradeOffer {
  proposer: TradeQuantity[];
  recipient: TradeQuantity[];
}
export interface TradeItem extends TradeQuantity {
  side: "PROPOSER" | "RECIPIENT";
  name: string;
  rarity: Rarity;
}
export interface TradePlayer {
  id: string;
  userId: string;
}
export interface Trade {
  id: string;
  proposer: TradePlayer;
  recipient: TradePlayer;
  items: TradeItem[];
  status: TradeStatus;
  createdAt: Date;
  completedAt: Date | null;
}
export interface TradeTransaction {
  proposer: TradePlayer;
  recipient: TradePlayer;
  describe(offer: TradeOffer): Promise<TradeItem[]>;
  copies(
    playerId: string,
    item: TradeQuantity,
    lock: boolean,
  ): Promise<string[]>;
  insert(id: string, items: TradeItem[]): Promise<Trade>;
  transfer(instanceIds: string[], ownerId: string): Promise<void>;
  transition(
    trade: Trade,
    status: TradeStatus,
    completedAt: Date | null,
  ): Promise<Trade>;
}
export interface TradeRepository {
  withParticipants<T>(
    proposerId: string,
    recipientId: string,
    operation: (tx: TradeTransaction) => Promise<T>,
  ): Promise<T>;
  withTrade<T>(
    id: string,
    operation: (tx: TradeTransaction, trade: Trade) => Promise<T>,
  ): Promise<T>;
  find(id: string): Promise<Trade | undefined>;
}
export class TradeError extends Error {}
export class TradeOwnershipError extends TradeError {
  constructor() {
    super(
      "A player no longer owns the required card quantities. No cards were transferred; the trade remains pending.",
    );
  }
}
const userId = z.string().regex(/^\d{1,20}$/);
const quantity = z.object({
  cardId: z.uuid().transform((id) => id.toLowerCase()),
  quantity: z.number().int().positive().max(2_147_483_647),
});
const offerSchema = z.object({
  proposer: z.array(quantity),
  recipient: z.array(quantity),
});

export function validateTradeOffer(input: TradeOffer): TradeOffer {
  const parsed = offerSchema.safeParse(input);
  if (!parsed.success)
    throw new TradeError(
      "Use card UUIDs and positive whole-number quantities.",
    );
  const aggregate = (items: TradeQuantity[]) => {
    const totals = new Map<string, number>();
    for (const item of items) {
      const total = (totals.get(item.cardId) ?? 0) + item.quantity;
      if (total > 2_147_483_647)
        throw new TradeError("Card quantity is too large.");
      totals.set(item.cardId, total);
    }
    return [...totals]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([cardId, quantity]) => ({ cardId, quantity }));
  };
  const offer = {
    proposer: aggregate(parsed.data.proposer),
    recipient: aggregate(parsed.data.recipient),
  };
  if (!offer.proposer.length && !offer.recipient.length)
    throw new TradeError("Add at least one card to the trade.");
  return offer;
}

export class TradeService {
  constructor(
    private readonly repository: TradeRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(
    proposerId: string,
    recipientId: string,
    input: TradeOffer,
  ): Promise<Trade> {
    if (
      !userId.safeParse(proposerId).success ||
      !userId.safeParse(recipientId).success
    )
      throw new TradeError("Invalid player ID.");
    if (proposerId === recipientId)
      throw new TradeError("You cannot trade with yourself.");
    const offer = validateTradeOffer(input);
    return this.repository.withParticipants(
      proposerId,
      recipientId,
      async (tx) => {
        const items = await tx.describe(offer);
        for (const item of items.filter((item) => item.side === "PROPOSER")) {
          if (
            (await tx.copies(tx.proposer.id, item, false)).length !==
            item.quantity
          )
            throw new TradeError(
              "You do not own the quantities you are offering.",
            );
        }
        return tx.insert(randomUUID(), items);
      },
    );
  }

  async show(id: string): Promise<Trade> {
    if (!z.uuid().safeParse(id).success)
      throw new TradeError("Invalid trade UUID.");
    const trade = await this.repository.find(id);
    if (!trade) throw new TradeError("Trade not found.");
    return trade;
  }

  async act(actorId: string, id: string, action: TradeAction): Promise<Trade> {
    if (
      !userId.safeParse(actorId).success ||
      !z.uuid().safeParse(id).success ||
      !["accept", "reject", "cancel"].includes(action)
    )
      throw new TradeError("Invalid trade action.");
    return this.repository.withTrade(id, async (tx, trade) => {
      const authorized =
        action === "cancel" ? trade.proposer.userId : trade.recipient.userId;
      if (actorId !== authorized)
        throw new TradeError(
          action === "cancel"
            ? "Only the proposer can cancel this trade."
            : "Only the recipient can accept or reject this trade.",
        );
      if (trade.status !== "PENDING")
        throw new TradeError(
          `This trade is already ${trade.status.toLowerCase()}.`,
        );
      if (action !== "accept")
        return tx.transition(
          trade,
          action === "reject" ? "REJECTED" : "CANCELLED",
          null,
        );
      const transfers: { ids: string[]; ownerId: string }[] = [];
      // Select both sides before moving anything, including when both offer the same card.
      for (const item of trade.items) {
        const from = item.side === "PROPOSER" ? tx.proposer : tx.recipient;
        const to = item.side === "PROPOSER" ? tx.recipient : tx.proposer;
        const ids = await tx.copies(from.id, item, true);
        if (ids.length !== item.quantity) throw new TradeOwnershipError();
        transfers.push({ ids, ownerId: to.id });
      }
      for (const transfer of transfers)
        await tx.transfer(transfer.ids, transfer.ownerId);
      return tx.transition(trade, "COMPLETED", this.now());
    });
  }
}
