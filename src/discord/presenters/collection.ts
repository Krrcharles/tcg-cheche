import {
  AttachmentBuilder,
  escapeMarkdown,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  TextDisplayBuilder,
} from "discord.js";
import type {
  CollectionEntry,
  CollectionPage,
} from "../../domain/collections/collection-service.js";
import type { AssetStorage } from "../../storage/asset-storage.js";
import {
  type CollectionState,
  collectionControls,
} from "../components/collection.js";

export function presentCollectionText(content: string) {
  return {
    flags: MessageFlags.IsComponentsV2 as const,
    components: [new TextDisplayBuilder().setContent(content)],
    files: [] as AttachmentBuilder[],
    attachments: [],
    allowedMentions: { parse: [] as never[] },
  };
}

async function cardImages(
  entries: CollectionEntry[],
  storage: Pick<AssetStorage, "get">,
) {
  const images = await Promise.allSettled(
    entries.map((entry) => storage.get(entry.assetKey)),
  );
  const files: AttachmentBuilder[] = [];
  const gallery = new MediaGalleryBuilder();
  const missing: string[] = [];
  entries.forEach((entry, index) => {
    const image = images[index];
    if (image?.status !== "fulfilled") {
      missing.push(escapeMarkdown(entry.name));
      return;
    }
    const bytes = image.value;
    const extension =
      bytes.subarray(0, 3).toString() === "GIF"
        ? "gif"
        : bytes.subarray(8, 12).toString() === "WEBP"
          ? "webp"
          : bytes[0] === 0xff && bytes[1] === 0xd8
            ? "jpg"
            : "png";
    const name = `collection-${index + 1}.${extension}`;
    files.push(new AttachmentBuilder(bytes, { name }));
    gallery.addItems(
      new MediaGalleryItemBuilder()
        .setURL(`attachment://${name}`)
        .setDescription(
          `${entry.name} | ${entry.rarity} | ${entry.ownedCount} copies`,
        ),
    );
  });
  return { files, gallery, missing };
}

function cardLine(entry: CollectionEntry) {
  return `${escapeMarkdown(entry.name.slice(0, 100))} | ${entry.rarity} | ${entry.ownedCount} copies`;
}

export async function presentCollection(
  result: CollectionPage,
  state: CollectionState,
  storage: Pick<AssetStorage, "get">,
) {
  const text = `Collection of <@${result.userId}>\n${result.collectedCount} / ${result.catalogueCount} cards collected · ${result.totalCopies} total copies\nPage ${result.page} / ${result.pageCount} · Sort: ${result.sort}\n\n${result.entries.map(cardLine).join("\n") || "No cards collected yet."}`;
  const reply = presentCollectionText(text);
  const components: (
    | TextDisplayBuilder
    | MediaGalleryBuilder
    | ReturnType<typeof collectionControls>[number]
  )[] = [...reply.components];
  if (state.mode === "gallery" && result.entries.length) {
    const images = await cardImages(result.entries, storage);
    reply.files = images.files;
    if (images.files.length) components.push(images.gallery);
    if (images.missing.length)
      components.push(
        new TextDisplayBuilder().setContent(
          `Images temporarily unavailable for: ${images.missing.join(", ")}.`,
        ),
      );
  }
  components.push(...collectionControls(result, state));
  return { ...reply, components };
}

export async function presentCardDetail(
  card: CollectionEntry,
  userId: string,
  storage: Pick<AssetStorage, "get">,
) {
  const images = await cardImages([card], storage);
  const reply = presentCollectionText(
    `Card detail · <@${userId}>\n${cardLine(card)}`,
  );
  const components: (TextDisplayBuilder | MediaGalleryBuilder)[] = [
    ...reply.components,
  ];
  if (images.files.length) components.push(images.gallery);
  else
    components.push(
      new TextDisplayBuilder().setContent("Image temporarily unavailable."),
    );
  return { ...reply, components, files: images.files };
}
