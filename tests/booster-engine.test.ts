import { describe, expect, it } from "vitest";
import { loadGameConfiguration } from "../src/config/game.js";
import { rollBooster, rollRarity } from "../src/domain/boosters/engine.js";
import { gameDay } from "../src/domain/boosters/game-day.js";
import { type Card, rarities } from "../src/domain/cards/card.js";

const config = loadGameConfiguration();
const catalogue: Card[] = rarities.flatMap((rarity, index) =>
  [0, 1].map((copy) => ({
    id: `${index}-${copy}`,
    name: `${rarity} ${copy}`,
    rarity,
    assetKey: `cards/${index}-${copy}`,
    enabled: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  })),
);

describe("configured booster engine", () => {
  it.each([
    [0, "COMMON"],
    [0.699999, "COMMON"],
    [0.7, "UNCOMMON"],
    [0.92, "RARE"],
    [0.98, "EPIC"],
    [0.997, "LEGENDARY"],
    [0.999999999, "LEGENDARY"],
  ] as const)("selects the weighted interval at %s", (value, rarity) => {
    expect(rollRarity(config.rarity_tables.normal ?? {}, () => value)).toBe(
      rarity,
    );
  });

  it.each([0, 0.7, 0.85, 0.98, 0.999999])(
    "returns five cards with a rare-or-better final slot at %s",
    (value) => {
      const cards = rollBooster(config, "standard", catalogue, () => value);
      expect(cards).toHaveLength(5);
      expect(["RARE", "EPIC", "LEGENDARY"]).toContain(cards[4]?.rarity);
    },
  );

  it("allows duplicate copies without depleting catalogue supply", () => {
    const cards = rollBooster(config, "standard", catalogue, () => 0);
    expect(cards.slice(0, 4)).toEqual(Array(4).fill(catalogue[0]));
    expect(rollBooster(config, "standard", catalogue, () => 0)).toEqual(cards);
    expect(catalogue).toHaveLength(10);
  });

  it.each([0, 0.499999, 0.5, 0.999999])(
    "selects cards uniformly within rarity at %s",
    (value) => {
      let call = 0;
      const cards = rollBooster(config, "standard", catalogue, () =>
        call++ % 2 === 0 ? 0 : value,
      );
      expect(cards[0]?.id).toBe(value < 0.5 ? "0-0" : "0-1");
    },
  );

  it("excludes disabled cards even when supplied by a caller", () => {
    const cards = rollBooster(
      config,
      "standard",
      catalogue.map((card) => ({ ...card, enabled: card.id.endsWith("1") })),
      () => 0,
    );
    expect(cards.every((card) => card.enabled && card.id.endsWith("1"))).toBe(
      true,
    );
  });

  it("refuses incomplete catalogues instead of changing the odds", () => {
    expect(() =>
      rollBooster(
        config,
        "standard",
        catalogue.filter((card) => card.rarity !== "LEGENDARY"),
        () => 0,
      ),
    ).toThrow("no enabled LEGENDARY cards");
  });

  it("uses custom slot names, lengths and weights without special rarity branches", () => {
    const custom = structuredClone(config);
    custom.rarity_tables.only_epic = { COMMON: 0, EPIC: 100 };
    custom.boosters.definitions.custom = { slots: ["only_epic", "only_epic"] };
    const cards = rollBooster(
      custom,
      "custom",
      catalogue.filter((card) => card.rarity === "EPIC"),
      () => 0,
    );
    expect(cards.map((card) => card.rarity)).toEqual(["EPIC", "EPIC"]);
  });

  it.each([-1, 1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid random samples %s",
    (value) => {
      expect(() =>
        rollBooster(config, "standard", catalogue, () => value),
      ).toThrow("[0, 1)");
    },
  );

  it.each(["missing", "toString"])("rejects unknown booster %s", (name) => {
    expect(() => rollBooster(config, name, catalogue)).toThrow(
      "Unknown booster",
    );
  });
});

describe("configured calendar day", () => {
  it.each([
    ["2026-01-01T22:59:59.999Z", "Europe/Paris", "2026-01-01", "2026-01-02"],
    ["2026-01-01T23:00:00Z", "Europe/Paris", "2026-01-02", "2026-01-03"],
    ["2026-08-31T22:00:00Z", "Europe/Paris", "2026-09-01", "2026-09-02"],
    ["2026-12-31T23:00:00Z", "Europe/Paris", "2027-01-01", "2027-01-02"],
    ["2028-02-28T23:00:00Z", "Europe/Paris", "2028-02-29", "2028-03-01"],
    ["2026-01-01T01:00:00Z", "America/New_York", "2025-12-31", "2026-01-01"],
  ])("maps %s in %s", (instant, timezone, date, nextDate) => {
    expect(gameDay(new Date(instant), timezone)).toEqual({
      date,
      nextDate,
      timezone,
    });
  });
});
