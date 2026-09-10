import { Client, Events, GatewayIntentBits } from "discord.js";
import { loadEnvironment } from "./config/env.js";
import { startApplication } from "./discord/application.js";

async function main() {
  const environment = loadEnvironment();
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  client.once(Events.ClientReady, () => {
    console.info(`TCG Cheche ready for guild ${environment.DISCORD_GUILD_ID}.`);
  });
  client.on(Events.Error, () => {
    console.error("Discord client error.");
  });
  await startApplication(client, environment.DISCORD_TOKEN);
}

void main().catch((error: unknown) => {
  console.error(
    error instanceof Error &&
      error.message.startsWith("Invalid environment configuration:")
      ? error.message
      : "Application startup failed. Check Discord credentials and connectivity.",
  );
  process.exitCode = 1;
});
