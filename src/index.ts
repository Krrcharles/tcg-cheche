import { Client, Events, GatewayIntentBits } from "discord.js";
import { ConfigurationError } from "./config/error.js";
import { loadConfiguration } from "./config/index.js";
import { startApplication } from "./discord/application.js";

async function main() {
  const { environment } = loadConfiguration();
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
    error instanceof ConfigurationError
      ? error.message
      : "Application startup failed. Check Discord credentials and connectivity.",
  );
  process.exitCode = 1;
});
