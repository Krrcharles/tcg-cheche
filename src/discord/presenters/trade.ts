import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  escapeMarkdown,
} from "discord.js";
import type { Trade, TradeItem } from "../../domain/trades/trade-service.js";

export function tradeText(
  proposerId: string,
  recipientId: string,
  items: TradeItem[],
) {
  return (
    [
      ["PROPOSER", proposerId],
      ["RECIPIENT", recipientId],
    ] as const
  )
    .map(([side, userId]) => {
      const lines = items
        .filter((item) => item.side === side)
        .map(
          (item) =>
            `${escapeMarkdown(item.name)} | ${item.rarity} | x${item.quantity}`,
        );
      return `<@${userId}> gives:\n${lines.join("\n") || "Nothing"}`;
    })
    .join("\n\n");
}

export function tradeMessage(
  title: string,
  text: string,
  buttons: { id: string; label: string; style: ButtonStyle }[],
) {
  const full = `${title}\n\n${text}`;
  return {
    content:
      full.length <= 2000
        ? full
        : `${title}\n\nFull offer attached as trade.txt. Review both sides before accepting.`,
    files:
      full.length <= 2000
        ? []
        : [new AttachmentBuilder(Buffer.from(full), { name: "trade.txt" })],
    attachments: [],
    allowedMentions: { parse: [] as const },
    components: buttons.length
      ? [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            buttons.map(({ id, label, style }) =>
              new ButtonBuilder()
                .setCustomId(id)
                .setLabel(label)
                .setStyle(style),
            ),
          ),
        ]
      : [],
  };
}

export function presentTrade(trade: Trade) {
  return tradeMessage(
    `Trade ${trade.id} — ${trade.status}`,
    tradeText(trade.proposer.userId, trade.recipient.userId, trade.items),
    trade.status === "PENDING"
      ? [
          {
            id: `trade:accept:${trade.id}`,
            label: "Accept",
            style: ButtonStyle.Success,
          },
          {
            id: `trade:reject:${trade.id}`,
            label: "Reject",
            style: ButtonStyle.Danger,
          },
          {
            id: `trade:cancel:${trade.id}`,
            label: "Cancel",
            style: ButtonStyle.Secondary,
          },
        ]
      : [],
  );
}
