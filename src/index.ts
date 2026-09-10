import { Client, Events, GatewayIntentBits } from "discord.js";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { ConfigurationError } from "./config/error.js";
import { loadConfiguration } from "./config/index.js";
import { DrizzleBoosterRepository } from "./db/repositories/boosters.js";
import { DrizzleCardRepository } from "./db/repositories/cards.js";
import { startApplication } from "./discord/application.js";
import {
  adminCardCommand,
  handleAdminCard,
} from "./discord/commands/admin-card.js";
import { boosterCommand, handleBooster } from "./discord/commands/booster.js";
import { createAdminGuard } from "./domain/administration/admin-guard.js";
import { BoosterService } from "./domain/boosters/booster-service.js";
import { CardService } from "./domain/cards/card-service.js";
import { S3AssetStorage } from "./storage/s3-asset-storage.js";

async function main() {
  const { environment, game } = loadConfiguration();
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const pool = new pg.Pool({ connectionString: environment.DATABASE_URL });
  pool.on("error", () => console.error("Database connection error."));
  const storage = new S3AssetStorage(environment);
  const db = drizzle(pool);
  const service = new CardService(
    new DrizzleCardRepository(db),
    storage,
    createAdminGuard(game.admin),
  );
  const boosters = new BoosterService(new DrizzleBoosterRepository(db), game);
  client.on(Events.InteractionCreate, (interaction) => {
    if (interaction.isChatInputCommand()) {
      void handleAdminCard(
        interaction,
        environment.DISCORD_GUILD_ID,
        service,
      ).catch(() => console.error("Discord admin response failed."));
      void handleBooster(
        interaction,
        environment.DISCORD_GUILD_ID,
        boosters,
        storage,
      ).catch(() => console.error("Discord booster response failed."));
    }
  });
  client.once(Events.ClientReady, () => {
    console.info(`TCG Cheche ready for guild ${environment.DISCORD_GUILD_ID}.`);
  });
  client.on(Events.Error, () => {
    console.error("Discord client error.");
  });
  const application = await startApplication(
    {
      login: (token) => client.login(token),
      destroy: async () => {
        try {
          await client.destroy();
        } finally {
          storage.destroy();
          await pool.end();
        }
      },
    },
    environment.DISCORD_TOKEN,
  );
  try {
    if (!client.application)
      throw new Error("Discord application is unavailable.");
    await client.application.commands.create(
      adminCardCommand(),
      environment.DISCORD_GUILD_ID,
    );
    await client.application.commands.create(
      boosterCommand(),
      environment.DISCORD_GUILD_ID,
    );
  } catch (error) {
    await application.stop();
    throw error;
  }
}

void main().catch((error: unknown) => {
  console.error(
    error instanceof ConfigurationError
      ? error.message
      : "Application startup failed. Check Discord configuration, command registration, and connectivity.",
  );
  process.exitCode = 1;
});
