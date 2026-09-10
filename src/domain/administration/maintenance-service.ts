import { z } from "zod";
import type { GameConfiguration } from "../../config/game.js";
import { type RandomSource, rollBooster } from "../boosters/engine.js";
import { type GameDay, gameDay } from "../boosters/game-day.js";
import { type Card, rarities } from "../cards/card.js";

// Operational request bounds, not gameplay balancing values.
export const maxAdminQuantity = 1_000;
export const maxSimulationCount = 1_000;
const targetUserId = z.string().regex(/^\d{1,20}$/);
const requestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("show"), targetUserId }),
  z.object({ operation: z.literal("reset-daily"), targetUserId }),
  z.object({
    operation: z.enum(["give-card", "remove-card"]),
    targetUserId,
    cardId: z.uuid(),
    quantity: z.number().int().min(1).max(maxAdminQuantity),
  }),
  z.object({
    operation: z.literal("simulate"),
    count: z.number().int().min(1).max(maxSimulationCount).default(1),
  }),
]);
export type MaintenanceRequest = z.input<typeof requestSchema>;
export class MaintenanceInputError extends Error {}
export class InsufficientCopiesError extends Error {
  constructor() {
    super("The player does not own enough copies of that card.");
  }
}

export interface PlayerSummary {
  playerId: string | null;
  collectedCount: number;
  totalCopies: number;
  used: number;
  pendingTrades: number;
}

export interface MaintenanceTransaction {
  show(day: GameDay): Promise<PlayerSummary>;
  give(cardId: string, quantity: number, obtainedAt: Date): Promise<void>;
  remove(cardId: string, quantity: number): Promise<void>;
  resetDaily(day: GameDay): Promise<number>;
}

export interface MaintenanceRepository {
  withPlayer<T>(
    userId: string,
    create: boolean,
    operation: (transaction: MaintenanceTransaction) => Promise<T>,
  ): Promise<T>;
  enabledCards(): Promise<Card[]>;
}

export class MaintenanceService {
  constructor(
    private readonly repository: MaintenanceRepository,
    private readonly config: GameConfiguration,
    readonly authorize: (userId: string) => void,
    private readonly random: RandomSource = Math.random,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(actorUserId: string, input: MaintenanceRequest) {
    this.authorize(actorUserId);
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success)
      throw new MaintenanceInputError(
        `Invalid admin input. Use a valid player and card UUID, quantity 1–${maxAdminQuantity}, or simulation count 1–${maxSimulationCount}.`,
      );
    const request = parsed.data;
    if (request.operation === "simulate") {
      // This path only reads the catalogue; it never creates or locks a player.
      const catalogue = await this.repository.enabledCards();
      const rarityCounts = Object.fromEntries(
        rarities.map((rarity) => [rarity, 0]),
      ) as Record<Card["rarity"], number>;
      const outcomes = new Map<
        string,
        {
          cardId: string;
          name: string;
          rarity: Card["rarity"];
          count: number;
        }
      >();
      for (const card of catalogue)
        outcomes.set(card.id, {
          cardId: card.id,
          name: card.name,
          rarity: card.rarity,
          count: 0,
        });
      let totalCards = 0;
      for (let i = 0; i < request.count; i++) {
        for (const card of rollBooster(
          this.config,
          "standard",
          catalogue,
          this.random,
        )) {
          rarityCounts[card.rarity]++;
          const outcome = outcomes.get(card.id);
          if (outcome) outcome.count++;
          totalCards++;
        }
      }
      return {
        kind: "simulation" as const,
        count: request.count,
        totalCards,
        rarityCounts,
        cards: [...outcomes.values()],
      };
    }

    const result = await this.repository.withPlayer(
      request.targetUserId,
      request.operation === "give-card",
      async (transaction) => {
        // Use the game day after acquiring the player lock, as real openings do.
        const now = this.now();
        const day = gameDay(now, this.config.game.timezone);
        if (request.operation === "show") {
          const summary = await transaction.show(day);
          const limit = this.config.boosters.daily_limit;
          return {
            kind: "player" as const,
            targetUserId: request.targetUserId,
            ...summary,
            limit,
            remaining: Math.max(0, limit - summary.used),
          };
        }
        if (request.operation === "reset-daily") {
          const clearedOpenings = await transaction.resetDaily(day);
          return {
            kind: "reset" as const,
            targetUserId: request.targetUserId,
            clearedOpenings,
            day: day.date,
          };
        }
        if (request.operation === "give-card")
          await transaction.give(request.cardId, request.quantity, now);
        else await transaction.remove(request.cardId, request.quantity);
        return { kind: "mutation" as const, ...request };
      },
    );
    // Log only after commit, before Discord delivery can fail.
    if (result.kind !== "player")
      console.info("Admin player mutation", {
        actorUserId,
        targetUserId: request.targetUserId,
        action: request.operation,
        ...(result.kind === "mutation"
          ? { cardId: result.cardId, quantity: result.quantity }
          : { day: result.day, clearedOpenings: result.clearedOpenings }),
      });
    return result;
  }
}

export type MaintenanceResult = Awaited<
  ReturnType<MaintenanceService["execute"]>
>;
