import { z } from "zod";
import { type Rarity, rarities } from "../cards/card.js";
import { CardNotFoundError } from "../cards/card-service.js";

export interface CollectionEntry {
  cardId: string;
  name: string;
  rarity: Rarity;
  assetKey: string;
  ownedCount: number;
}

export interface CollectionRepository {
  collection(userId: string): Promise<{
    entries: CollectionEntry[];
    catalogueCount: number;
  }>;
  card(userId: string, name: string): Promise<CollectionEntry | undefined>;
  names(query: string, limit: number): Promise<string[]>;
}

export const collectionSorts = ["rarity", "name", "quantity"] as const;
export type CollectionSort = (typeof collectionSorts)[number];
const userIdSchema = z.string().regex(/^\d{1,20}$/);
const querySchema = z.object({
  userId: userIdSchema,
  sort: z.enum(collectionSorts).default("rarity"),
  page: z.number().int().min(1).max(1_000_000).default(1),
});
export class CollectionInputError extends Error {
  constructor() {
    super(
      "Invalid collection input. Use a valid player, sort, page, or card name (1–100 characters).",
    );
  }
}

export class CollectionService {
  constructor(private readonly repository: CollectionRepository) {}

  async list(input: z.input<typeof querySchema>) {
    const parsed = querySchema.safeParse(input);
    if (!parsed.success) throw new CollectionInputError();
    const { userId, sort } = parsed.data;
    const { entries, catalogueCount } =
      await this.repository.collection(userId);
    const byName = (a: CollectionEntry, b: CollectionEntry) =>
      a.name.localeCompare(b.name, "en") || a.cardId.localeCompare(b.cardId);
    const ordered = [...entries].sort((a, b) => {
      const primary =
        sort === "rarity"
          ? rarities.indexOf(b.rarity) - rarities.indexOf(a.rarity)
          : sort === "quantity"
            ? b.ownedCount - a.ownedCount
            : 0;
      return primary || byName(a, b);
    });
    // One page size keeps list/gallery navigation identical and fits Discord galleries.
    const pageSize = 10;
    const pageCount = Math.max(1, Math.ceil(ordered.length / pageSize));
    const page = Math.min(parsed.data.page, pageCount);
    return {
      userId,
      sort,
      page,
      pageCount,
      entries: ordered.slice((page - 1) * pageSize, page * pageSize),
      collectedCount: entries.length,
      catalogueCount,
      totalCopies: entries.reduce((sum, entry) => sum + entry.ownedCount, 0),
    };
  }

  async names(query: string, limit: number) {
    if (
      !z.string().trim().max(100).safeParse(query).success ||
      !z.number().int().min(1).max(25).safeParse(limit).success
    )
      throw new CollectionInputError();
    return this.repository.names(query.trim(), limit);
  }

  async detail(userId: string, name: string) {
    const parsed = z.string().trim().min(1).max(100).safeParse(name);
    if (!userIdSchema.safeParse(userId).success || !parsed.success)
      throw new CollectionInputError();
    const card = await this.repository.card(userId, parsed.data);
    if (!card) throw new CardNotFoundError();
    return card;
  }
}

export type CollectionPage = Awaited<ReturnType<CollectionService["list"]>>;
