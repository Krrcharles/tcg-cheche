import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { startApplication } from "../src/discord/application.js";

function fixture() {
  return {
    client: {
      login: vi.fn().mockResolvedValue("token"),
      destroy: vi.fn().mockResolvedValue(undefined),
    },
    signals: new EventEmitter(),
  };
}

describe("application lifecycle", () => {
  it("starts and stops without a live Discord connection", async () => {
    const { client, signals } = fixture();
    const app = await startApplication(client, "test-token", signals);
    expect(client.login).toHaveBeenCalledWith("test-token");
    await Promise.all([app.stop(), app.stop()]);
    expect(client.destroy).toHaveBeenCalledTimes(1);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it.each(["SIGINT", "SIGTERM"])("shuts down on %s", async (signal) => {
    const { client, signals } = fixture();
    const app = await startApplication(client, "test-token", signals);
    signals.emit(signal);
    await app.stop();
    expect(client.destroy).toHaveBeenCalledTimes(1);
  });

  it("cleans up after a login failure", async () => {
    const { client, signals } = fixture();
    client.login.mockRejectedValue(new Error("login failed"));
    await expect(
      startApplication(client, "test-token", signals),
    ).rejects.toThrow("login failed");
    expect(client.destroy).toHaveBeenCalledTimes(1);
    expect(signals.eventNames()).toEqual([]);
  });

  it("reports shutdown failures and removes signal listeners", async () => {
    const { client, signals } = fixture();
    const error = new Error("shutdown failed");
    client.destroy.mockRejectedValue(error);
    const onError = vi.fn();
    const app = await startApplication(client, "test-token", signals, onError);
    signals.emit("SIGTERM");
    await expect(app.stop()).rejects.toThrow("shutdown failed");
    expect(onError).toHaveBeenCalledWith(error);
    expect(signals.eventNames()).toEqual([]);
  });
});
