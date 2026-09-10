export const rarities = [
  "COMMON",
  "UNCOMMON",
  "RARE",
  "EPIC",
  "LEGENDARY",
] as const;
export type Rarity = (typeof rarities)[number];

export interface Card {
  id: string;
  name: string;
  rarity: Rarity;
  assetKey: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CardRepository {
  create(
    card: Pick<Card, "id" | "name" | "rarity" | "assetKey">,
  ): Promise<Card>;
  find(id: string): Promise<Card | undefined>;
  list(offset: number, limit: number): Promise<Card[]>;
  update(
    id: string,
    changes: Partial<Pick<Card, "name" | "rarity" | "enabled">>,
  ): Promise<Card | undefined>;
}
