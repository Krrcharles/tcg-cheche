import {
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { CardNotFoundError } from "../../domain/cards/card-service.js";
import {
  CollectionInputError,
  type CollectionService,
} from "../../domain/collections/collection-service.js";
import type { AssetStorage } from "../../storage/asset-storage.js";
import {
  type CollectionState,
  parseCollectionCustomId,
} from "../components/collection.js";
import {
  presentCardDetail,
  presentCollection,
  presentCollectionText,
} from "../presenters/collection.js";

export function collectionCommand() {
  return new SlashCommandBuilder()
    .setName("collection")
    .setDescription("Browse a card collection")
    .addUserOption((option) =>
      option
        .setName("player")
        .setDescription("Player to browse (defaults to you)"),
    )
    .toJSON();
}

export function cardCommand() {
  return new SlashCommandBuilder()
    .setName("card")
    .setDescription("Inspect a card and owned quantity")
    .addStringOption((option) =>
      option
        .setName("name")
        .setDescription("Card name")
        .setAutocomplete(true)
        .setMaxLength(100)
        .setRequired(true),
    )
    .addUserOption((option) =>
      option
        .setName("player")
        .setDescription("Whose owned quantity to show (defaults to you)"),
    )
    .toJSON();
}

type Service = Pick<CollectionService, "list" | "detail">;
function errorMessage(error: unknown) {
  if (
    error instanceof CollectionInputError ||
    error instanceof CardNotFoundError
  )
    return error.message;
  console.error("Collection operation or response failed.");
  return "Collection request failed. Please try again.";
}

export async function handleCollectionCommand(
  interaction: ChatInputCommandInteraction,
  guildId: string,
  service: Service,
  storage: Pick<AssetStorage, "get">,
) {
  if (
    interaction.guildId !== guildId ||
    !["collection", "card"].includes(interaction.commandName)
  )
    return;
  try {
    await interaction.deferReply();
    const userId =
      interaction.options.getUser("player")?.id ?? interaction.user.id;
    if (interaction.commandName === "card") {
      const card = await service.detail(
        userId,
        interaction.options.getString("name", true),
      );
      await interaction.editReply(
        await presentCardDetail(card, userId, storage),
      );
    } else {
      const state: CollectionState = {
        viewerId: interaction.user.id,
        userId,
        sort: "rarity",
        mode: "list",
        page: 1,
      };
      const result = await service.list(state);
      await interaction.editReply(
        await presentCollection(result, state, storage),
      );
    }
  } catch (error) {
    const reply = presentCollectionText(errorMessage(error));
    if (interaction.deferred) await interaction.editReply(reply);
    else
      await interaction.reply({
        ...reply,
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
  }
}

export async function handleCardAutocomplete(
  interaction: AutocompleteInteraction,
  guildId: string,
  service: Pick<CollectionService, "names">,
) {
  if (interaction.guildId !== guildId || interaction.commandName !== "card")
    return;
  const focused = interaction.options.getFocused(true);
  if (focused.name !== "name") return;
  let names: string[] = [];
  try {
    names = await service.names(String(focused.value), 25);
  } catch {
    console.error("Card autocomplete lookup failed.");
  }
  await interaction.respond(
    names.slice(0, 25).map((name) => ({ name, value: name })),
  );
}

export async function handleCollectionButton(
  interaction: ButtonInteraction,
  guildId: string,
  service: Service,
  storage: Pick<AssetStorage, "get">,
) {
  if (
    interaction.guildId !== guildId ||
    !interaction.customId.startsWith("collection:")
  )
    return;
  const state = parseCollectionCustomId(interaction.customId);
  if (!state || state.viewerId !== interaction.user.id) {
    await interaction.reply({
      content: state
        ? "Use /collection to open your own browsing controls."
        : "Invalid collection control. Use /collection to start again.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  try {
    await interaction.deferUpdate();
    const result = await service.list(state);
    await interaction.editReply(
      await presentCollection(result, state, storage),
    );
  } catch (error) {
    // Preserve the previous page and its controls so a transient failure can be retried.
    const reply = {
      content: errorMessage(error),
      flags: MessageFlags.Ephemeral as const,
    };
    if (interaction.deferred) await interaction.followUp(reply);
    else await interaction.reply(reply);
  }
}
