import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AssetStorage } from "../../storage/asset-storage.js";
import { type CardRepository, rarities } from "./card.js";

export class CardInputError extends Error {}
export class CardNotFoundError extends Error {
  constructor() {
    super("Card not found.");
  }
}

export const maxImageBytes = 8 * 1024 * 1024;
export const imageTypes = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;
const imageSchema = z.object({
  bytes: z
    .instanceof(Uint8Array)
    .refine(
      (bytes) => bytes.byteLength > 0 && bytes.byteLength <= maxImageBytes,
    ),
  contentType: z.enum(imageTypes),
});
const name = z.string().trim().min(1).max(100);
const rarity = z.enum(rarities);
const id = z.uuid();
const requestSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("create"),
    name,
    rarity,
    image: imageSchema,
  }),
  z
    .object({
      operation: z.literal("edit"),
      id,
      name: name.optional(),
      rarity: rarity.optional(),
    })
    .refine(
      (value) => value.name !== undefined || value.rarity !== undefined,
      "Provide a name or rarity to edit.",
    ),
  z.object({ operation: z.literal("show"), id }),
  z.object({
    operation: z.literal("list"),
    page: z.number().int().min(1).max(1_000_000),
  }),
  z.object({ operation: z.literal("enable"), id }),
  z.object({ operation: z.literal("disable"), id }),
  z.object({ operation: z.literal("replace-image"), id, image: imageSchema }),
]);
export type CardRequest = z.infer<typeof requestSchema>;

export class CardService {
  constructor(
    private readonly repository: CardRepository,
    private readonly storage: AssetStorage,
    readonly authorize: (userId: string) => void,
  ) {}

  async execute(userId: string, input: CardRequest) {
    this.authorize(userId);
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success)
      throw new CardInputError(
        "Invalid card input. Use a valid UUID, name (1–100 characters), rarity, and PNG/JPEG/WebP/GIF image up to 8 MiB.",
      );
    const request = parsed.data;
    if (request.operation === "list") {
      const rows = await this.repository.list((request.page - 1) * 10, 11);
      return {
        kind: "list" as const,
        cards: rows.slice(0, 10),
        page: request.page,
        hasNext: rows.length > 10,
      };
    }
    if (request.operation === "create") {
      const cardId = randomUUID();
      const assetKey = `cards/${cardId}`;
      await this.storage.put(
        assetKey,
        request.image.bytes,
        request.image.contentType,
      );
      // S3 and PostgreSQL cannot share a transaction. Keep an orphan on DB failure
      // rather than risking deletion after an ambiguous commit/connection failure.
      const card = await this.repository.create({
        id: cardId,
        name: request.name,
        rarity: request.rarity,
        assetKey,
      });
      return { kind: "card" as const, card };
    }
    if (request.operation === "show" || request.operation === "replace-image") {
      const card = await this.repository.find(request.id);
      if (!card) throw new CardNotFoundError();
      if (request.operation === "show") {
        return {
          kind: "card" as const,
          card,
          image: await this.storage.get(card.assetKey),
        };
      }
      await this.storage.put(
        card.assetKey,
        request.image.bytes,
        request.image.contentType,
      );
      const updated = await this.repository.update(card.id, {});
      if (!updated) throw new CardNotFoundError();
      return { kind: "card" as const, card: updated };
    }
    const changes =
      request.operation === "edit"
        ? {
            ...(request.name !== undefined ? { name: request.name } : {}),
            ...(request.rarity !== undefined ? { rarity: request.rarity } : {}),
          }
        : { enabled: request.operation === "enable" };
    const card = await this.repository.update(request.id, changes);
    if (!card) throw new CardNotFoundError();
    return { kind: "card" as const, card };
  }
}
export type CardResult = Awaited<ReturnType<CardService["execute"]>>;
