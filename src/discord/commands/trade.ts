import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder,
  type ButtonInteraction,
  ButtonStyle,
  type ChatInputCommandInteraction,
  MessageFlags,
  ModalBuilder,
  type ModalSubmitInteraction,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { z } from "zod";
import { CardNotFoundError } from "../../domain/cards/card-service.js";
import {
  CollectionInputError,
  type CollectionService,
} from "../../domain/collections/collection-service.js";
import {
  TradeError,
  type TradeItem,
  type TradeOffer,
  type TradeService,
  validateTradeOffer,
} from "../../domain/trades/trade-service.js";
import { presentTrade, tradeMessage, tradeText } from "../presenters/trade.js";

export function tradeCommand() {
  return new SlashCommandBuilder()
    .setName("trade")
    .setDescription(
      "Build a trade with a player, or reopen a saved trade by ID",
    )
    .addUserOption((option) =>
      option.setName("player").setDescription("Player to trade with"),
    )
    .addStringOption((option) =>
      option
        .setName("id")
        .setDescription(
          "Existing trade UUID to view instead of building an offer",
        ),
    )
    .toJSON();
}

export function parseTradeLines(value: string) {
  return value
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const match = /^\s*(.+)\s+x(\d+)\s*$/i.exec(line);
      const name = match?.[1]?.trim();
      const quantity = Number(match?.[2]);
      if (
        !name ||
        name.length > 100 ||
        !Number.isSafeInteger(quantity) ||
        quantity <= 0
      )
        throw new TradeError(
          "Use one Card Name xN per line, with a positive whole-number quantity and a name of 1–100 characters.",
        );
      return { name, quantity };
    });
}

interface Draft {
  id: string;
  recipientId: string;
  offer: TradeOffer;
  items: TradeItem[];
  busy: boolean;
}

function form(draft: Draft) {
  const field = (side: "proposer" | "recipient", label: string) =>
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId(side)
        .setLabel(label)
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(4000)
        .setPlaceholder("Kevin au Buffalo Grill x2\nThomas Crocs x1")
        .setValue(
          draft.items
            .filter(
              (item) =>
                item.side === (side === "proposer" ? "PROPOSER" : "RECIPIENT"),
            )
            .map((item) => `${item.name} x${item.quantity}`)
            .join("\n"),
        ),
    );
  return new ModalBuilder()
    .setCustomId(`trade:build:${draft.id}`)
    .setTitle("Build offer — preview before sending")
    .addComponents(
      field("proposer", "You give: Card Name xN"),
      field("recipient", "You request: Card Name xN"),
    );
}

type Interaction =
  | ChatInputCommandInteraction
  | ButtonInteraction
  | ModalSubmitInteraction;
async function report(
  interaction: Interaction,
  error: unknown,
  preserveMessage = false,
) {
  const expected =
    error instanceof TradeError ||
    error instanceof CardNotFoundError ||
    error instanceof CollectionInputError;
  if (!expected) console.error("Trade operation or Discord response failed.");
  const content = expected
    ? error.message
    : "Trade request failed. Check the saved trade status before retrying.";
  const reply = {
    content,
    allowedMentions: { parse: [] as const },
    flags: MessageFlags.Ephemeral as const,
  };
  if (interaction.deferred && !interaction.replied && !preserveMessage)
    await interaction.editReply({
      content,
      allowedMentions: reply.allowedMentions,
      components: [],
      attachments: [],
    });
  else if (interaction.deferred || interaction.replied)
    await interaction.followUp(reply);
  else await interaction.reply(reply);
}

// At most one private, unsent draft per player. Pending trades and their actions
// live in PostgreSQL and remain usable across restarts; this is only UI state.
export function createTradeHandlers(
  guildId: string,
  service: Pick<TradeService, "create" | "act" | "show">,
  collections: Pick<CollectionService, "detail">,
) {
  const drafts = new Map<string, Draft>();
  function requireDraft(
    interaction: ButtonInteraction | ModalSubmitInteraction,
    id: string,
  ) {
    const draft = drafts.get(interaction.user.id);
    if (!draft || draft.id !== id)
      throw new TradeError(
        "This draft is no longer active. Use /trade player to start again.",
      );
    if (draft.busy)
      throw new TradeError("This draft is being processed. Please wait.");
    return draft;
  }
  return {
    command: async (interaction: ChatInputCommandInteraction) => {
      if (
        interaction.guildId !== guildId ||
        interaction.commandName !== "trade"
      )
        return;
      try {
        const id = interaction.options.getString("id");
        const player = interaction.options.getUser("player");
        if (id && player)
          throw new TradeError(
            "Choose a player for a new offer, or an ID to view an existing trade.",
          );
        if (id) {
          await interaction.deferReply();
          await interaction.editReply(presentTrade(await service.show(id)));
          return;
        }
        if (!player)
          throw new TradeError(
            "Choose a player to trade with, or enter an existing trade ID.",
          );
        if (player.id === interaction.user.id)
          throw new TradeError("You cannot trade with yourself.");
        if (drafts.get(interaction.user.id)?.busy)
          throw new TradeError(
            "Your previous draft is being processed. Please wait.",
          );
        const draft: Draft = {
          id: randomUUID(),
          recipientId: player.id,
          offer: { proposer: [], recipient: [] },
          items: [],
          busy: false,
        };
        await interaction.showModal(form(draft));
        drafts.set(interaction.user.id, draft);
      } catch (error) {
        await report(interaction, error);
      }
    },
    modal: async (interaction: ModalSubmitInteraction) => {
      if (
        interaction.guildId !== guildId ||
        !interaction.customId.startsWith("trade:")
      )
        return;
      let draft: Draft | undefined;
      try {
        const match = /^trade:build:([\da-f-]+)$/.exec(interaction.customId);
        if (!match?.[1]) throw new TradeError("Invalid trade form.");
        draft = requireDraft(interaction, match[1]);
        draft.busy = true;
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const lines = {
          proposer: parseTradeLines(
            interaction.fields.getTextInputValue("proposer"),
          ),
          recipient: parseTradeLines(
            interaction.fields.getTextInputValue("recipient"),
          ),
        };
        const resolved: TradeItem[] = [];
        const quantities: TradeOffer = { proposer: [], recipient: [] };
        for (const side of ["proposer", "recipient"] as const) {
          for (const item of lines[side]) {
            const card = await collections.detail(
              side === "proposer" ? interaction.user.id : draft.recipientId,
              item.name,
            );
            quantities[side].push({
              cardId: card.cardId,
              quantity: item.quantity,
            });
            resolved.push({
              cardId: card.cardId,
              quantity: item.quantity,
              side: side === "proposer" ? "PROPOSER" : "RECIPIENT",
              name: card.name,
              rarity: card.rarity,
            });
          }
        }
        const offer = validateTradeOffer(quantities);
        const items = (["proposer", "recipient"] as const).flatMap((side) =>
          offer[side].map((item) => {
            const card = resolved.find((card) => card.cardId === item.cardId);
            if (!card) throw new CardNotFoundError();
            return {
              ...card,
              ...item,
              side:
                side === "proposer"
                  ? ("PROPOSER" as const)
                  : ("RECIPIENT" as const),
            };
          }),
        );
        // A fresh ID invalidates all older previews of this draft.
        draft.id = randomUUID();
        draft.offer = offer;
        draft.items = items;
        await interaction.editReply(
          tradeMessage(
            "Private trade preview — nothing reserved",
            tradeText(interaction.user.id, draft.recipientId, items),
            [
              {
                id: `trade:send:${draft.id}`,
                label: "Send proposal",
                style: ButtonStyle.Success,
              },
              {
                id: `trade:edit:${draft.id}`,
                label: "Edit draft",
                style: ButtonStyle.Secondary,
              },
            ],
          ),
        );
      } catch (error) {
        await report(interaction, error);
      } finally {
        if (draft) draft.busy = false;
      }
    },
    button: async (interaction: ButtonInteraction) => {
      if (
        interaction.guildId !== guildId ||
        !interaction.customId.startsWith("trade:")
      )
        return;
      let draft: Draft | undefined;
      try {
        const match =
          /^trade:(accept|reject|cancel|edit|send):([\da-f-]+)$/.exec(
            interaction.customId,
          );
        const action = match?.[1];
        const id = match?.[2];
        if (!action || !id || !z.uuid().safeParse(id).success)
          throw new TradeError("Invalid trade control.");
        if (action === "edit" || action === "send") {
          const current = requireDraft(interaction, id);
          if (action === "edit") {
            await interaction.showModal(form(current));
            return;
          }
          draft = current;
          draft.busy = true;
          await interaction.deferUpdate();
          const trade = await service.create(
            interaction.user.id,
            draft.recipientId,
            draft.offer,
          );
          drafts.delete(interaction.user.id);
          // Give the proposer a durable recovery ID before publishing. A failed
          // delivery never recreates or automatically cancels a saved proposal.
          try {
            await interaction.editReply({
              content: `Saved trade ${trade.id}. Use /trade id:${trade.id} to reopen it.`,
              components: [],
              attachments: [],
            });
            await interaction.followUp(presentTrade(trade));
          } catch {
            throw new TradeError(
              `Trade ${trade.id} was saved, but delivery failed. Use /trade id:${trade.id} to reopen it.`,
            );
          }
          return;
        }
        await interaction.deferUpdate();
        const trade = await service.act(
          interaction.user.id,
          id,
          action as "accept" | "reject" | "cancel",
        );
        try {
          await interaction.editReply(presentTrade(trade));
        } catch {
          throw new TradeError(
            `Trade ${trade.id} is ${trade.status.toLowerCase()}, but the message update failed. Use /trade id:${trade.id} to check it.`,
          );
        }
      } catch (error) {
        await report(interaction, error, true);
      } finally {
        if (draft) draft.busy = false;
      }
    },
  };
}
