import { describe, expect, it } from "vitest";
import { loadEnvironment } from "../src/config/env.js";

describe("environment configuration", () => {
  it("preserves Discord IDs as strings and defaults to development", () => {
    expect(
      loadEnvironment({
        DISCORD_TOKEN: "test-token",
        DISCORD_GUILD_ID: "123456789012345678",
      }),
    ).toEqual({
      NODE_ENV: "development",
      DISCORD_TOKEN: "test-token",
      DISCORD_GUILD_ID: "123456789012345678",
    });
  });

  it.each([{}, { DISCORD_TOKEN: " " }, { DISCORD_GUILD_ID: "invalid" }])(
    "rejects missing or invalid configuration: %j",
    (environment) => {
      expect(() => loadEnvironment(environment)).toThrow(
        "Invalid environment configuration:",
      );
    },
  );

  it("does not expose tokens in validation errors", () => {
    try {
      loadEnvironment({
        DISCORD_TOKEN: "secret-token",
        DISCORD_GUILD_ID: "invalid",
      });
      expect.fail("Expected invalid configuration to throw");
    } catch (error) {
      expect(String(error)).toContain("DISCORD_GUILD_ID");
      expect(String(error)).not.toContain("secret-token");
    }
  });

  it.each([
    { DISCORD_TOKEN: " " },
    { DISCORD_GUILD_ID: "invalid" },
    { NODE_ENV: "invalid" },
  ])(
    "rejects invalid fields with otherwise valid settings: %j",
    (overrides) => {
      expect(() =>
        loadEnvironment({
          DISCORD_TOKEN: "test-token",
          DISCORD_GUILD_ID: "123456789012345678",
          ...overrides,
        }),
      ).toThrow("Invalid environment configuration:");
    },
  );
});
