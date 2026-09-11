import { AttachmentBuilder, EmbedBuilder, escapeMarkdown } from "discord.js";
import type {
  BoosterOpening,
  BoosterStatus,
} from "../../domain/boosters/booster-service.js";
import type { AssetStorage } from "../../storage/asset-storage.js";

export function presentBoosterStatus(status: BoosterStatus) {
  return `${status.remaining} / ${status.limit} boosters remaining today (${status.used} opened). Resets <t:${Math.floor(status.resetsAt.getTime() / 1000)}:R>.`;
}

export async function presentBoosterOpening(
  opening: BoosterOpening,
  storage: Pick<AssetStorage, "get">,
) {
  const images = await Promise.allSettled(
    opening.cards.map((card) => storage.get(card.assetKey)),
  );
  const files: AttachmentBuilder[] = [];
  const embeds = opening.cards.map((card, index) => {
    const embed = new EmbedBuilder()
      .setTitle(card.name.slice(0, 100))
      .setDescription(card.rarity);
    const image = images[index];
    if (image?.status === "fulfilled") {
      const bytes = image.value;
      const extension =
        bytes.subarray(0, 3).toString() === "GIF"
          ? "gif"
          : bytes.subarray(8, 12).toString() === "WEBP"
            ? "webp"
            : bytes[0] === 0xff && bytes[1] === 0xd8
              ? "jpg"
              : "png";
      const name = `booster-${index + 1}.${extension}`;
      files.push(new AttachmentBuilder(bytes, { name }));
      embed.setImage(`attachment://${name}`);
    } else {
      embed.setFooter({
        text: "Image temporarily unavailable. This card is saved.",
      });
    }
    return embed;
  });
  return {
    content: `Booster opened! ${presentBoosterStatus(opening.status)}`,
    embeds,
    files,
    allowedMentions: { parse: [] as never[] },
  };
}

export function presentLegendaryAnnouncement(
  opening: BoosterOpening,
  userId: string,
) {
  const legendary = opening.cards.filter((card) => card.rarity === "LEGENDARY");
  if (!legendary.length) return undefined;
  return {
    content: `🌟 <@${userId}> pulled LEGENDARY cards!\n${legendary.map((card) => `• ${escapeMarkdown(card.name.slice(0, 100))}`).join("\n")}`,
    allowedMentions: { parse: [] as never[] },
  };
}
