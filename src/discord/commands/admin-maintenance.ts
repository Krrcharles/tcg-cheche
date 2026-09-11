import {
  AttachmentBuilder,
  type ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandSubcommandGroupBuilder,
} from "discord.js";
import { AdminAuthorizationError } from "../../domain/administration/admin-guard.js";
import {
  InsufficientCopiesError,
  MaintenanceInputError,
  type MaintenanceRequest,
  type MaintenanceResult,
  type MaintenanceService,
  maxAdminQuantity,
  maxSimulationCount,
} from "../../domain/administration/maintenance-service.js";
import { BoosterUnavailableError } from "../../domain/boosters/engine.js";
import { CardNotFoundError } from "../../domain/cards/card-service.js";
import { adminCardCommand } from "./admin-card.js";

export function adminCommand() {
  const player = new SlashCommandSubcommandGroupBuilder()
    .setName("player")
    .setDescription("Inspect and maintain players");
  for (const [name, description] of [
    ["show", "Show collection size, daily usage, and pending trades"],
    ["give-card", "Give copies of a card"],
    ["remove-card", "Remove copies of a card"],
    [
      "reset-daily",
      "Clear today's opening history, preserving all owned cards",
    ],
  ] as const) {
    player.addSubcommand((command) => {
      command
        .setName(name)
        .setDescription(description)
        .addUserOption((option) =>
          option
            .setName("player")
            .setDescription("Target player")
            .setRequired(true),
        );
      if (name === "give-card" || name === "remove-card") {
        command
          .addStringOption((option) =>
            option
              .setName("card")
              .setDescription("Card UUID")
              .setRequired(true),
          )
          .addIntegerOption((option) =>
            option
              .setName("quantity")
              .setDescription("Number of copies")
              .setMinValue(1)
              .setMaxValue(maxAdminQuantity)
              .setRequired(true),
          );
      }
      return command;
    });
  }
  const booster = new SlashCommandSubcommandGroupBuilder()
    .setName("booster")
    .setDescription("Inspect booster balancing")
    .addSubcommand((command) =>
      command
        .setName("simulate")
        .setDescription(
          "Simulate standard boosters without changing game state",
        )
        .addIntegerOption((option) =>
          option
            .setName("count")
            .setDescription("Number of boosters (default: 1)")
            .setMinValue(1)
            .setMaxValue(maxSimulationCount),
        ),
    );
  const card = adminCardCommand();
  return {
    ...card,
    options: [...(card.options ?? []), player.toJSON(), booster.toJSON()],
  };
}

function readRequest(
  interaction: ChatInputCommandInteraction,
): MaintenanceRequest {
  const options = interaction.options;
  const operation = options.getSubcommand();
  if (options.getSubcommandGroup() === "booster" && operation === "simulate")
    return { operation, count: options.getInteger("count") ?? 1 };
  if (options.getSubcommandGroup() === "player") {
    const targetUserId = options.getUser("player", true).id;
    if (operation === "show" || operation === "reset-daily")
      return { operation, targetUserId };
    if (operation === "give-card" || operation === "remove-card")
      return {
        operation,
        targetUserId,
        cardId: options.getString("card", true),
        quantity: options.getInteger("quantity", true),
      };
  }
  throw new MaintenanceInputError("Unknown admin maintenance command.");
}

export function presentMaintenanceResult(result: MaintenanceResult) {
  let content: string;
  const files: AttachmentBuilder[] = [];
  if (result.kind === "simulation") {
    content = [
      `Simulated ${result.count} standard boosters · ${result.totalCards} cards. No game state changed.`,
      ...Object.entries(result.rarityCounts).map(
        ([rarity, count]) =>
          `${rarity}: ${count} (${((100 * count) / result.totalCards).toFixed(2)}%)`,
      ),
      "Full card counts (including zero draws) are attached.",
    ].join("\n");
    files.push(
      new AttachmentBuilder(Buffer.from(JSON.stringify(result, null, 2)), {
        name: "booster-simulation.json",
      }),
    );
  } else if (result.kind === "player") {
    content = [
      `Player <@${result.targetUserId}> · ${result.playerId ?? "not registered"}`,
      `${result.collectedCount} distinct cards · ${result.totalCopies} total copies`,
      `Today's boosters: ${result.used}/${result.limit} · ${result.remaining} remaining`,
      `Pending trades: ${result.pendingTrades}`,
    ].join("\n");
  } else if (result.kind === "reset") {
    content = `Cleared ${result.clearedOpenings} opening records for <@${result.targetUserId}> on ${result.day}. All cards and ownership were preserved.`;
  } else {
    content = `${result.operation === "give-card" ? "Gave" : "Removed"} ${result.quantity} copies of ${result.cardId} ${result.operation === "give-card" ? "to" : "from"} <@${result.targetUserId}>.`;
  }
  return { content, files, allowedMentions: { parse: [] as never[] } };
}

export async function handleAdminMaintenance(
  interaction: ChatInputCommandInteraction,
  guildId: string,
  service: MaintenanceService,
) {
  if (
    interaction.guildId !== guildId ||
    interaction.commandName !== "admin" ||
    !["player", "booster"].includes(
      interaction.options.getSubcommandGroup() ?? "",
    )
  )
    return;
  try {
    service.authorize(interaction.user.id);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await service.execute(
      interaction.user.id,
      readRequest(interaction),
    );
    await interaction.editReply(presentMaintenanceResult(result));
  } catch (error) {
    const known =
      error instanceof AdminAuthorizationError ||
      error instanceof MaintenanceInputError ||
      error instanceof InsufficientCopiesError ||
      error instanceof CardNotFoundError ||
      error instanceof BoosterUnavailableError;
    if (!known) console.error("Admin maintenance operation failed.");
    const content = known
      ? error.message
      : "Admin operation failed. Check player state before retrying.";
    if (interaction.deferred)
      await interaction.editReply({ content, files: [] });
    else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  }
}
