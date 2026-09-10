import {
  AttachmentBuilder,
  type ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type SlashCommandSubcommandBuilder,
} from "discord.js";
import { AdminAuthorizationError } from "../../domain/administration/admin-guard.js";
import { type Rarity, rarities } from "../../domain/cards/card.js";
import {
  CardInputError,
  CardNotFoundError,
  type CardRequest,
  type CardResult,
  type CardService,
  imageTypes,
  maxImageBytes,
} from "../../domain/cards/card-service.js";

function withId(command: SlashCommandSubcommandBuilder) {
  return command.addStringOption((option) =>
    option.setName("id").setDescription("Card UUID").setRequired(true),
  );
}
function withMetadata(
  command: SlashCommandSubcommandBuilder,
  required: boolean,
) {
  return command
    .addStringOption((option) =>
      option
        .setName("name")
        .setDescription("Card display name")
        .setMinLength(1)
        .setMaxLength(100)
        .setRequired(required),
    )
    .addStringOption((option) =>
      option
        .setName("rarity")
        .setDescription("Card rarity")
        .setRequired(required)
        .addChoices(...rarities.map((value) => ({ name: value, value }))),
    );
}
function withImage(command: SlashCommandSubcommandBuilder) {
  return command.addAttachmentOption((option) =>
    option
      .setName("image")
      .setDescription("PNG, JPEG, WebP or GIF, up to 8 MiB")
      .setRequired(true),
  );
}

export function adminCardCommand() {
  return new SlashCommandBuilder()
    .setName("admin")
    .setDescription("Game administration")
    .addSubcommandGroup((group) =>
      group
        .setName("card")
        .setDescription("Manage the card catalogue")
        .addSubcommand((command) =>
          withImage(
            withMetadata(
              command.setName("create").setDescription("Create a card"),
              true,
            ),
          ),
        )
        .addSubcommand((command) =>
          withMetadata(
            withId(
              command.setName("edit").setDescription("Edit name or rarity"),
            ),
            false,
          ),
        )
        .addSubcommand((command) =>
          withId(
            command
              .setName("show")
              .setDescription("Show a complete card record and image"),
          ),
        )
        .addSubcommand((command) =>
          command
            .setName("list")
            .setDescription("List all cards, including disabled cards")
            .addIntegerOption((option) =>
              option
                .setName("page")
                .setDescription("Page number")
                .setMinValue(1)
                .setMaxValue(1_000_000),
            ),
        )
        .addSubcommand((command) =>
          withId(
            command
              .setName("enable")
              .setDescription("Enable a card for future boosters"),
          ),
        )
        .addSubcommand((command) =>
          withId(
            command
              .setName("disable")
              .setDescription("Disable a card for future boosters"),
          ),
        )
        .addSubcommand((command) =>
          withImage(
            withId(
              command
                .setName("replace-image")
                .setDescription("Replace the shared card image"),
            ),
          ),
        ),
    )
    .toJSON();
}

async function readRequest(
  interaction: ChatInputCommandInteraction,
): Promise<CardRequest> {
  const options = interaction.options;
  const operation = options.getSubcommand();
  if (operation === "list")
    return { operation, page: options.getInteger("page") ?? 1 };
  if (operation === "create" || operation === "replace-image") {
    const attachment = options.getAttachment("image", true);
    const contentType = attachment.contentType;
    if (
      !contentType ||
      !imageTypes.includes(contentType as (typeof imageTypes)[number]) ||
      attachment.size <= 0 ||
      attachment.size > maxImageBytes
    ) {
      throw new CardInputError(
        "Use a PNG, JPEG, WebP or GIF image up to 8 MiB.",
      );
    }
    const url = new URL(attachment.url);
    if (
      url.protocol !== "https:" ||
      !["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname)
    )
      throw new CardInputError("Use a Discord image attachment.");
    const response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error("Attachment download failed.");
    const image = {
      bytes: new Uint8Array(await response.arrayBuffer()),
      contentType: contentType as (typeof imageTypes)[number],
    };
    return operation === "create"
      ? {
          operation,
          name: options.getString("name", true),
          rarity: options.getString("rarity", true) as Rarity,
          image,
        }
      : { operation, id: options.getString("id", true), image };
  }
  const id = options.getString("id", true);
  if (operation === "edit") {
    const name = options.getString("name");
    const rarity = options.getString("rarity") as Rarity | null;
    return {
      operation,
      id,
      ...(name !== null ? { name } : {}),
      ...(rarity !== null ? { rarity } : {}),
    };
  }
  if (operation === "show" || operation === "enable" || operation === "disable")
    return { operation, id };
  throw new CardInputError("Unknown admin card command.");
}

export function presentCardResult(result: CardResult) {
  const embed = new EmbedBuilder();
  const files: AttachmentBuilder[] = [];
  if (result.kind === "list") {
    embed.setTitle(`Card catalogue — page ${result.page}`);
    if (result.cards.length === 0)
      embed.setDescription("No cards on this page.");
    for (const card of result.cards) {
      embed.addFields({
        name: card.name.slice(0, 100),
        value: `${card.id}\n${card.rarity} · ${card.enabled ? "enabled" : "disabled"}`,
      });
    }
    if (result.hasNext)
      embed.setFooter({
        text: `More cards: /admin card list page:${result.page + 1}`,
      });
  } else {
    const card = result.card;
    embed
      .setTitle(card.name.slice(0, 100))
      .addFields(
        { name: "ID", value: card.id },
        { name: "Rarity", value: card.rarity, inline: true },
        { name: "Enabled", value: String(card.enabled), inline: true },
        { name: "Asset key", value: card.assetKey.slice(0, 1024) },
        { name: "Created", value: card.createdAt.toISOString() },
        { name: "Updated", value: card.updatedAt.toISOString() },
      );
    if (result.image) {
      // The key stays stable when replacing with another format. Derive the
      // Discord filename from bytes rather than from the key's old extension.
      const bytes = result.image;
      const extension =
        bytes.subarray(0, 3).toString() === "GIF"
          ? "gif"
          : bytes.subarray(8, 12).toString() === "WEBP"
            ? "webp"
            : bytes[0] === 0xff && bytes[1] === 0xd8
              ? "jpg"
              : "png";
      const filename = `card-image.${extension}`;
      files.push(new AttachmentBuilder(bytes, { name: filename }));
      embed.setImage(`attachment://${filename}`);
    }
  }
  return { embeds: [embed], files, allowedMentions: { parse: [] as never[] } };
}

export async function handleAdminCard(
  interaction: ChatInputCommandInteraction,
  guildId: string,
  service: CardService,
) {
  if (
    interaction.guildId !== guildId ||
    interaction.commandName !== "admin" ||
    interaction.options.getSubcommandGroup() !== "card"
  )
    return;
  try {
    // Authorize before even downloading the attachment; the service also guards
    // every operation for callers outside Discord.
    service.authorize(interaction.user.id);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const request = await readRequest(interaction);
    const result = await service.execute(interaction.user.id, request);
    if (request.operation !== "show" && request.operation !== "list") {
      console.info("Admin card mutation", {
        userId: interaction.user.id,
        operation: request.operation,
        cardId: result.kind === "card" ? result.card.id : undefined,
      });
    }
    await interaction.editReply(presentCardResult(result));
  } catch (error) {
    const known =
      error instanceof AdminAuthorizationError ||
      error instanceof CardInputError ||
      error instanceof CardNotFoundError;
    if (!known) console.error("Admin card operation failed.");
    const content = known
      ? error.message
      : "Card operation failed. Check the card record before retrying.";
    if (interaction.deferred)
      await interaction.editReply({ content, embeds: [], files: [] });
    else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  }
}
