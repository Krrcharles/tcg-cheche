import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import {
  loadGameConfiguration,
  parseGameConfiguration,
} from "../src/config/game.js";

const source = readFileSync("config/game.yaml", "utf8");

describe("game configuration", () => {
  it("loads the versioned balancing settings", () => {
    const config = loadGameConfiguration();
    expect(config.game.timezone).toBe("Europe/Paris");
    expect(config.boosters.daily_limit).toBe(3);
    expect(config.boosters.definitions.standard?.slots).toEqual([
      "normal",
      "normal",
      "normal",
      "normal",
      "rare_plus",
    ]);
    expect(config.rarity_tables.normal?.LEGENDARY).toBe(0.3);
  });
  it("preserves quoted admin IDs and supports additional tables and boosters", () => {
    const config = parse(source);
    config.admin = {
      user_ids: ["123456789012345678"],
      role_ids: ["987654321098765432"],
    };
    config.boosters.daily_limit = 7;
    config.rarity_tables.special = { EPIC: 100 };
    config.boosters.definitions.special = { slots: ["special"] };
    expect(parseGameConfiguration(stringify(config))).toEqual(config);
  });
  it.each([
    [
      "timezone",
      (config: ReturnType<typeof parse>) => {
        config.game.timezone = "Invalid/Timezone";
      },
    ],
    [
      "timezone",
      (config: ReturnType<typeof parse>) => {
        config.game.timezone = "+01:00";
      },
    ],
    [
      "rarity table",
      (config: ReturnType<typeof parse>) => {
        delete config.rarity_tables.rare_plus;
      },
    ],
    [
      "rarity table",
      (config: ReturnType<typeof parse>) => {
        config.boosters.definitions.standard.slots = ["toString"];
      },
    ],
    [
      "rarity_tables",
      (config: ReturnType<typeof parse>) => {
        config.rarity_tables.normal.MYTHIC = 0;
      },
    ],
    [
      "total 100",
      (config: ReturnType<typeof parse>) => {
        config.rarity_tables.normal.COMMON = 69;
      },
    ],
    [
      "total 100",
      (config: ReturnType<typeof parse>) => {
        config.rarity_tables.normal = {};
      },
    ],
    [
      "rarity_tables",
      (config: ReturnType<typeof parse>) => {
        config.rarity_tables.normal = { COMMON: -1, RARE: 101 };
      },
    ],
    [
      "rarity_tables",
      (config: ReturnType<typeof parse>) => {
        config.rarity_tables.normal.COMMON = "70";
      },
    ],
    [
      "admin.user_ids",
      (config: ReturnType<typeof parse>) => {
        config.admin.user_ids = [123456789012345680];
      },
    ],
    [
      "admin.user_ids",
      (config: ReturnType<typeof parse>) => {
        config.admin.user_ids = ["invalid"];
      },
    ],
    [
      "admin.role_ids",
      (config: ReturnType<typeof parse>) => {
        config.admin.role_ids = ["invalid"];
      },
    ],
    [
      "daily_limit",
      (config: ReturnType<typeof parse>) => {
        config.boosters.daily_limit = 0;
      },
    ],
    [
      "daily_limit",
      (config: ReturnType<typeof parse>) => {
        config.boosters.daily_limit = 1.5;
      },
    ],
    [
      "slots",
      (config: ReturnType<typeof parse>) => {
        config.boosters.definitions.standard.slots = [];
      },
    ],
    [
      "definitions",
      (config: ReturnType<typeof parse>) => {
        config.boosters.definitions = {};
      },
    ],
  ])("rejects invalid %s", (message, mutate) => {
    const config = parse(source);
    mutate(config);
    expect(() => parseGameConfiguration(stringify(config))).toThrow(message);
  });
  it.each(["", "[]", "game: [", "game: 1\ngame: 2"])(
    "rejects malformed or incomplete YAML: %s",
    (yaml) => {
      expect(() => parseGameConfiguration(yaml)).toThrow(
        "Invalid game configuration:",
      );
    },
  );
  it("reports an unreadable configuration file", () => {
    expect(() => loadGameConfiguration("config/nonexistent.yaml")).toThrow(
      "cannot read config/nonexistent.yaml",
    );
  });
});
