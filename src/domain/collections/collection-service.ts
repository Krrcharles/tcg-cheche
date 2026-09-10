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
  card(userId: string, cardId: string): Promise<CollectionEntry | undefined>;
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
      "Invalid collection input. Use a valid player, sort, page, or card UUID.",
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

  async detail(userId: string, cardId: string) {
    if (
      !userIdSchema.safeParse(userId).success ||
      !z.uuid().safeParse(cardId).success
    )
      throw new CollectionInputError();
    const card = await this.repository.card(userId, cardId);
    if (!card) throw new CardNotFoundError();
    return card;
  }
}

export type CollectionPage = Awaited<ReturnType<CollectionService["list"]>>;
