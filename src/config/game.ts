import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import { ConfigurationError } from "./error.js";

const discordId = z
  .string()
  .regex(/^\d{17,20}$/, "Expected a Discord snowflake string");
const probability = z.number().min(0).max(100).optional();
const rarityTable = z
  .strictObject({
    COMMON: probability,
    UNCOMMON: probability,
    RARE: probability,
    EPIC: probability,
    LEGENDARY: probability,
  })
  .refine(
    (table) =>
      Math.abs(
        Object.values(table).reduce<number>(
          (sum, value) => sum + (value ?? 0),
          0,
        ) - 100,
      ) < 1e-8,
    "Rarity probabilities must total 100",
  );

const gameSchema = z
  .strictObject({
    game: z.strictObject({
      timezone: z
        .string()
        .min(1)
        .refine((timezone) => {
          try {
            new Intl.DateTimeFormat("en", { timeZone: timezone });
            return !/^[+-]/.test(timezone);
          } catch {
            return false;
          }
        }, "Expected a valid IANA timezone"),
    }),
    admin: z.strictObject({
      user_ids: z.array(discordId),
      role_ids: z.array(discordId),
    }),
    boosters: z.strictObject({
      daily_limit: z.number().int().positive(),
      definitions: z
        .record(
          z.string().min(1),
          z.strictObject({
            slots: z.array(z.string().min(1)).min(1),
          }),
        )
        .refine(
          (definitions) => Object.keys(definitions).length > 0,
          "At least one booster definition is required",
        ),
    }),
    rarity_tables: z.record(z.string().min(1), rarityTable),
  })
  .superRefine((config, context) => {
    for (const [name, definition] of Object.entries(
      config.boosters.definitions,
    )) {
      definition.slots.forEach((table, index) => {
        if (!Object.hasOwn(config.rarity_tables, table)) {
          context.addIssue({
            code: "custom",
            path: ["boosters", "definitions", name, "slots", index],
            message: `Unknown rarity table: ${table}`,
          });
        }
      });
    }
  });

export type GameConfiguration = z.infer<typeof gameSchema>;

export function parseGameConfiguration(source: string): GameConfiguration {
  let data: unknown;
  try {
    data = parse(source);
  } catch {
    throw new ConfigurationError("Invalid game configuration: malformed YAML");
  }
  const result = gameSchema.safeParse(data);
  if (!result.success) {
    throw new ConfigurationError(
      `Invalid game configuration: ${result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return result.data;
}

export function loadGameConfiguration(
  path = "config/game.yaml",
): GameConfiguration {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    throw new ConfigurationError(
      `Invalid game configuration: cannot read ${path}`,
    );
  }
  return parseGameConfiguration(source);
}
