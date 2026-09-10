import { describe, expect, it } from "vitest";
import { loadEnvironment } from "../src/config/env.js";

const validEnvironment = {
  DISCORD_TOKEN: "test-token",
  DISCORD_GUILD_ID: "123456789012345678",
  DATABASE_URL: "postgresql://user:password@localhost:5432/tcg_test",
  S3_ENDPOINT: "http://localhost:9000",
  S3_ACCESS_KEY_ID: "test-access-key",
  S3_SECRET_ACCESS_KEY: "test-secret-key",
  S3_BUCKET: "tcg-assets",
};

describe("environment configuration", () => {
  it("preserves Discord IDs as strings and supplies infrastructure defaults", () => {
    expect(loadEnvironment(validEnvironment)).toEqual({
      ...validEnvironment,
      NODE_ENV: "development",
      S3_REGION: "us-east-1",
      S3_FORCE_PATH_STYLE: true,
    });
  });
  it("accepts explicit infrastructure options and ignores unrelated environment variables", () => {
    expect(
      loadEnvironment({
        ...validEnvironment,
        NODE_ENV: "production",
        S3_REGION: "eu-west-1",
        S3_FORCE_PATH_STYLE: "false",
        PATH: "ignored",
      }),
    ).toEqual({
      ...validEnvironment,
      NODE_ENV: "production",
      S3_REGION: "eu-west-1",
      S3_FORCE_PATH_STYLE: false,
    });
  });
  it.each(Object.keys(validEnvironment))("requires %s", (field) => {
    const environment: NodeJS.ProcessEnv = { ...validEnvironment };
    delete environment[field];
    expect(() => loadEnvironment(environment)).toThrow(field);
  });
  it.each([
    ["DISCORD_TOKEN", " "],
    ["DISCORD_GUILD_ID", "invalid"],
    ["NODE_ENV", "invalid"],
    ["DATABASE_URL", "https://localhost/database"],
    ["DATABASE_URL", "not-a-url"],
    ["S3_ENDPOINT", "ftp://localhost"],
    ["S3_ENDPOINT", "not-a-url"],
    ["S3_ACCESS_KEY_ID", " "],
    ["S3_SECRET_ACCESS_KEY", " "],
    ["S3_BUCKET", " "],
    ["S3_REGION", " "],
    ["S3_FORCE_PATH_STYLE", "yes"],
  ])("rejects invalid %s", (field, value) => {
    expect(() =>
      loadEnvironment({ ...validEnvironment, [field]: value }),
    ).toThrow(field);
  });
  it("does not expose secrets in validation errors", () => {
    try {
      loadEnvironment({
        ...validEnvironment,
        DATABASE_URL: "secret-database-url",
        DISCORD_GUILD_ID: "invalid",
      });
      expect.fail("Expected invalid configuration to throw");
    } catch (error) {
      expect(String(error)).toContain("DISCORD_GUILD_ID");
      for (const secret of [
        "test-token",
        "test-access-key",
        "test-secret-key",
        "secret-database-url",
      ]) {
        expect(String(error)).not.toContain(secret);
      }
    }
  });
});
