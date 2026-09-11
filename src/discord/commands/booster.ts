import {
  type ChatInputCommandInteraction,
  escapeMarkdown,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import {
  type BoosterOpening,
  BoosterQuotaError,
  type BoosterService,
} from "../../domain/boosters/booster-service.js";
import { BoosterUnavailableError } from "../../domain/boosters/engine.js";
import type { AssetStorage } from "../../storage/asset-storage.js";
import {
  presentBoosterOpening,
  presentBoosterStatus,
  presentLegendaryAnnouncement,
} from "../presenters/booster.js";

export function boosterCommand() {
  return new SlashCommandBuilder()
    .setName("booster")
    .setDescription("Daily boosters")
    .addSubcommand((command) =>
      command
        .setName("status")
        .setDescription("Show today's remaining boosters"),
    )
    .addSubcommand((command) =>
      command.setName("open").setDescription("Open a standard booster"),
    )
    .toJSON();
}

export async function handleBooster(
  interaction: ChatInputCommandInteraction,
  guildId: string,
  service: Pick<BoosterService, "status" | "open">,
  storage: Pick<AssetStorage, "get">,
) {
  if (interaction.guildId !== guildId || interaction.commandName !== "booster")
    return;
  let opening: BoosterOpening | undefined;
  try {
    const operation = interaction.options.getSubcommand();
    await interaction.deferReply(
      operation === "open" ? {} : { flags: MessageFlags.Ephemeral },
    );
    if (operation === "status") {
      await interaction.editReply({
        content: presentBoosterStatus(
          await service.status(interaction.user.id),
        ),
      });
      return;
    }
    if (operation !== "open")
      throw new BoosterUnavailableError("Unknown booster command.");
    opening = await service.open(interaction.user.id);
    await interaction.editReply(await presentBoosterOpening(opening, storage));
  } catch (error) {
    const known =
      error instanceof BoosterQuotaError ||
      error instanceof BoosterUnavailableError;
    if (!known) console.error("Booster operation or response failed.");
    const content = opening
      ? `Your booster was saved, but its reveal failed. Opening: ${opening.id}.\n${opening.cards.map((card) => `${card.rarity}: ${escapeMarkdown(card.name)}`).join("\n")}`
      : error instanceof BoosterQuotaError
        ? `${error.message} ${presentBoosterStatus(error.status)}`
        : known
          ? error.message
          : "Booster operation failed. Check /booster status before retrying.";
    const reply = {
      content,
      embeds: [],
      files: [],
      allowedMentions: { parse: [] as never[] },
    };
    if (interaction.deferred) await interaction.editReply(reply);
    else await interaction.reply({ ...reply, flags: MessageFlags.Ephemeral });
  }
  if (opening) {
    const announcement = presentLegendaryAnnouncement(
      opening,
      interaction.user.id,
    );
    if (announcement) {
      try {
        await interaction.followUp(announcement);
      } catch {
        console.error(
          "Legendary announcement failed; booster is already saved.",
        );
      }
    }
  }
}
