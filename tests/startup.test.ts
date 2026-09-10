import { afterEach, describe, expect, it, vi } from "vitest";

const { loadConfiguration, client } = vi.hoisted(() => ({
  loadConfiguration: vi.fn(),
  client: vi.fn(),
}));
vi.mock("../src/config/index.js", () => ({ loadConfiguration }));
vi.mock("discord.js", () => ({
  Client: client,
  Events: {},
  GatewayIntentBits: { Guilds: 1 },
}));

describe("startup configuration failures", () => {
  const originalExitCode = process.exitCode;
  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.resetModules();
  });

  it.each(["environment", "game"])(
    "fails before constructing Discord on invalid %s configuration",
    async (kind) => {
      const { ConfigurationError } = await import("../src/config/error.js");
      const message = `Invalid ${kind} configuration: invalid field`;
      loadConfiguration.mockImplementation(() => {
        throw new ConfigurationError(message);
      });
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      await import("../src/index.js");
      expect(loadConfiguration).toHaveBeenCalledTimes(1);
      expect(client).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(message);
      expect(process.exitCode).toBe(1);
    },
  );
});
