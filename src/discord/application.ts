import type { Client } from "discord.js";

type SignalSource = {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
};

export async function startApplication(
  client: Pick<Client, "login" | "destroy">,
  token: string,
  signals: SignalSource = process,
  onShutdownError: (error: unknown) => void = () => {
    console.error("Discord shutdown failed.");
    process.exitCode = 1;
  },
) {
  let stopping: Promise<void> | undefined;

  function stop(): Promise<void> {
    stopping ??= Promise.resolve()
      .then(() => client.destroy())
      .finally(() => {
        signals.off("SIGINT", handleSignal);
        signals.off("SIGTERM", handleSignal);
      });
    return stopping;
  }

  function handleSignal() {
    void stop().catch(onShutdownError);
  }

  signals.on("SIGINT", handleSignal);
  signals.on("SIGTERM", handleSignal);
  try {
    await client.login(token);
  } catch (error) {
    await stop();
    throw error;
  }
  return { stop };
}
