import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { z } from "zod";
import {
  type CollectionPage,
  collectionSorts,
} from "../../domain/collections/collection-service.js";

const stateSchema = z.object({
  viewerId: z.string().regex(/^\d{1,20}$/),
  userId: z.string().regex(/^\d{1,20}$/),
  sort: z.enum(collectionSorts),
  mode: z.enum(["list", "gallery"]),
  page: z.coerce.number().int().min(1).max(1_000_000),
});
export type CollectionState = z.infer<typeof stateSchema>;

export function collectionCustomId(state: CollectionState, control = "open") {
  return `collection:${state.viewerId}:${state.userId}:${state.sort}:${state.mode}:${state.page}:${control}`;
}

export function parseCollectionCustomId(
  customId: string,
): CollectionState | undefined {
  const [prefix, viewerId, userId, sort, mode, page, control, ...extra] =
    customId.split(":");
  if (prefix !== "collection" || !control || extra.length) return undefined;
  const parsed = stateSchema.safeParse({ viewerId, userId, sort, mode, page });
  return parsed.success ? parsed.data : undefined;
}

export function collectionControls(
  result: CollectionPage,
  state: CollectionState,
) {
  const current = {
    ...state,
    page: result.page,
    sort: result.sort,
    userId: result.userId,
  };
  const button = (
    label: string,
    destination: CollectionState,
    disabled = false,
  ) =>
    new ButtonBuilder()
      .setCustomId(collectionCustomId(destination, label.toLowerCase()))
      .setLabel(label)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled);
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      button(
        "Previous",
        { ...current, page: Math.max(1, result.page - 1) },
        result.page === 1,
      ),
      button(
        "Next",
        { ...current, page: result.page + 1 },
        result.page === result.pageCount,
      ),
      button(state.mode === "list" ? "Gallery" : "List", {
        ...current,
        mode: state.mode === "list" ? "gallery" : "list",
      }),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...collectionSorts.map((sort) =>
        button(
          { rarity: "Rarity", name: "Name", quantity: "Quantity" }[sort],
          { ...current, sort, page: 1 },
          sort === result.sort,
        ),
      ),
    ),
  ];
}
