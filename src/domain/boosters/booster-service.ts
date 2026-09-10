import type { GameConfiguration } from "../../config/game.js";
import type { Card } from "../cards/card.js";
import { type RandomSource, rollBooster } from "./engine.js";
import { type GameDay, gameDay } from "./game-day.js";

export interface BoosterTransaction {
  usage(day: GameDay): Promise<{ used: number; resetsAt: Date }>;
  enabledCards(): Promise<Card[]>;
  save(cards: Card[], openedAt: Date): Promise<string>;
}

export interface BoosterRepository {
  withPlayer<T>(
    discordUserId: string,
    operation: (transaction: BoosterTransaction) => Promise<T>,
  ): Promise<T>;
}

export interface BoosterStatus {
  used: number;
  limit: number;
  remaining: number;
  resetsAt: Date;
}

export interface BoosterOpening {
  id: string;
  cards: Card[];
  openedAt: Date;
  status: BoosterStatus;
}

export class BoosterQuotaError extends Error {
  constructor(readonly status: BoosterStatus) {
    super("Your daily booster quota has been reached.");
  }
}

export class BoosterService {
  constructor(
    private readonly repository: BoosterRepository,
    private readonly config: GameConfiguration,
    private readonly random: RandomSource = Math.random,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async getStatus(transaction: BoosterTransaction, now: Date) {
    const usage = await transaction.usage(
      gameDay(now, this.config.game.timezone),
    );
    const limit = this.config.boosters.daily_limit;
    return { ...usage, limit, remaining: Math.max(0, limit - usage.used) };
  }

  status(discordUserId: string): Promise<BoosterStatus> {
    return this.repository.withPlayer(discordUserId, (transaction) =>
      this.getStatus(transaction, this.now()),
    );
  }

  open(
    discordUserId: string,
    definition = "standard",
  ): Promise<BoosterOpening> {
    return this.repository.withPlayer(discordUserId, async (transaction) => {
      // Read time after acquiring the lock, including when waiting across midnight.
      const openedAt = this.now();
      const status = await this.getStatus(transaction, openedAt);
      if (!status.remaining) throw new BoosterQuotaError(status);
      const cards = rollBooster(
        this.config,
        definition,
        await transaction.enabledCards(),
        this.random,
      );
      const id = await transaction.save(cards, openedAt);
      return {
        id,
        cards,
        openedAt,
        status: {
          ...status,
          used: status.used + 1,
          remaining: status.remaining - 1,
        },
      };
    });
  }
}
