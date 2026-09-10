import type { GameConfiguration } from "../../config/game.js";
import { type Card, type Rarity, rarities } from "../cards/card.js";

export class BoosterUnavailableError extends Error {}
export type RandomSource = () => number;

function sample(random: RandomSource) {
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1)
    throw new Error("Random source must return a number in [0, 1).");
  return value;
}

export function rollRarity(
  table: GameConfiguration["rarity_tables"][string],
  random: RandomSource,
): Rarity {
  const weighted = rarities.filter((rarity) => (table[rarity] ?? 0) > 0);
  const total = weighted.reduce((sum, rarity) => sum + (table[rarity] ?? 0), 0);
  let remaining = sample(random) * total;
  for (const rarity of weighted) {
    remaining -= table[rarity] ?? 0;
    if (remaining < 0) return rarity;
  }
  // Account for floating-point rounding at the upper boundary.
  const last = weighted.at(-1);
  if (!last) throw new BoosterUnavailableError("Empty rarity table.");
  return last;
}

export function rollBooster(
  config: GameConfiguration,
  definitionName: string,
  catalogue: Card[],
  random: RandomSource = Math.random,
): Card[] {
  const definition = Object.hasOwn(config.boosters.definitions, definitionName)
    ? config.boosters.definitions[definitionName]
    : undefined;
  if (!definition) throw new BoosterUnavailableError("Unknown booster.");
  const pools = new Map(
    rarities.map((rarity) => [
      rarity,
      catalogue.filter((card) => card.enabled && card.rarity === rarity),
    ]),
  );
  // Reject an incomplete catalogue before rolling; never reroll missing rarities
  // or renormalize their probabilities, which would change the configured odds.
  const tables = definition.slots.map((slot) => {
    const table = Object.hasOwn(config.rarity_tables, slot)
      ? config.rarity_tables[slot]
      : undefined;
    if (!table) throw new BoosterUnavailableError("Unknown rarity table.");
    for (const rarity of rarities) {
      if ((table[rarity] ?? 0) > 0 && !pools.get(rarity)?.length)
        throw new BoosterUnavailableError(
          `Boosters are unavailable: no enabled ${rarity} cards.`,
        );
    }
    return table;
  });
  return tables.map((table) => {
    const pool = pools.get(rollRarity(table, random));
    const card = pool?.[Math.floor(sample(random) * pool.length)];
    if (!card) throw new BoosterUnavailableError("No eligible card.");
    return card;
  });
}
