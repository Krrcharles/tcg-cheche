import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { DrizzleCardRepository } from "../src/db/repositories/cards.js";
import {
  cardInstances,
  players,
  tradeItems,
  trades,
} from "../src/db/schema/index.js";
import {
  AdminAuthorizationError,
  createAdminGuard,
} from "../src/domain/administration/admin-guard.js";
import {
  type CardRequest,
  CardService,
  maxImageBytes,
} from "../src/domain/cards/card-service.js";

const admin = "123456789012345678";
const outsider = "123456789012345679";
const guard = createAdminGuard({ user_ids: [admin], role_ids: [outsider] });
const client = new PGlite();
const db = drizzle(client);
const repository = new DrizzleCardRepository(db);
const storage = { put: vi.fn(), get: vi.fn(), delete: vi.fn() };
const service = new CardService(repository, storage, guard);
const image = {
  bytes: Buffer.from("image"),
  contentType: "image/png" as const,
};
const create = {
  operation: "create",
  name: "Test card",
  rarity: "RARE",
  image,
} as const;
const missing = "00000000-0000-4000-8000-000000000099";

async function createCard() {
  const result = await service.execute(admin, create);
  if (result.kind !== "card") throw new Error("Expected a card");
  return result.card;
}

beforeAll(async () => {
  await migrate(db, { migrationsFolder: "src/db/migrations" });
}, 30_000);
beforeEach(async () => {
  vi.resetAllMocks();
  storage.get.mockResolvedValue(image.bytes);
  await client.exec("BEGIN");
});
afterEach(async () => {
  vi.useRealTimers();
  await client.exec("ROLLBACK");
  vi.restoreAllMocks();
});
afterAll(async () => {
  await client.close();
});

describe("admin authorization", () => {
  it("matches exact user snowflakes and ignores reserved role IDs", () => {
    expect(() => guard(admin)).not.toThrow();
    for (const user of [outsider, "", "123456789012345680"])
      expect(() => guard(user)).toThrow(AdminAuthorizationError);
    expect(() =>
      createAdminGuard({ user_ids: [], role_ids: [admin] })(admin),
    ).toThrow(AdminAuthorizationError);
  });

  it.each<CardRequest>([
    create,
    { operation: "edit", id: missing, name: "new" },
    { operation: "show", id: missing },
    { operation: "list", page: 1 },
    { operation: "enable", id: missing },
    { operation: "disable", id: missing },
    { operation: "replace-image", id: missing, image },
  ])("rejects $operation before repository/storage access", async (request) => {
    const spies = [
      vi.spyOn(repository, "create"),
      vi.spyOn(repository, "find"),
      vi.spyOn(repository, "list"),
      vi.spyOn(repository, "update"),
    ];
    await expect(service.execute(outsider, request)).rejects.toThrow(
      AdminAuthorizationError,
    );
    for (const spy of [...spies, storage.put, storage.get, storage.delete])
      expect(spy).not.toHaveBeenCalled();
  });
});

describe("card catalogue service and repository", () => {
  it("uploads at a generated key and permits duplicate names with distinct identities", async () => {
    const first = await createCard();
    const second = await createCard();
    expect(first.id).not.toBe(second.id);
    expect(first.name).toBe(second.name);
    expect(first.enabled).toBe(true);
    expect(first.assetKey).toBe(`cards/${first.id}`);
    expect(storage.put).toHaveBeenCalledWith(
      first.assetKey,
      image.bytes,
      image.contentType,
    );
    expect(await repository.find(first.id)).toEqual(first);
  });

  it("edits metadata and timestamps while preserving identity and the asset key", async () => {
    const card = await createCard();
    const updatedAt = new Date(card.updatedAt.getTime() + 1000);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(updatedAt);
    const result = await service.execute(admin, {
      operation: "edit",
      id: card.id,
      name: " Renamed ",
      rarity: "EPIC",
    });
    expect(result).toMatchObject({
      card: { ...card, name: "Renamed", rarity: "EPIC", updatedAt },
    });
    expect(storage.put).toHaveBeenCalledTimes(1);
  });

  it("shows disabled cards with their complete record and private image bytes", async () => {
    const card = await createCard();
    await service.execute(admin, { operation: "disable", id: card.id });
    expect(
      await service.execute(admin, { operation: "show", id: card.id }),
    ).toMatchObject({
      kind: "card",
      card: { id: card.id, enabled: false, assetKey: card.assetKey },
      image: image.bytes,
    });
    expect(storage.get).toHaveBeenCalledWith(card.assetKey);
  });

  it("disables and re-enables without changing existing ownership or trade references", async () => {
    const card = await createCard();
    const [owner, recipient] = await db
      .insert(players)
      .values([{ discordUserId: admin }, { discordUserId: outsider }])
      .returning();
    if (!owner || !recipient) throw new Error("Missing players");
    const copies = await db
      .insert(cardInstances)
      .values({
        cardId: card.id,
        ownerPlayerId: owner.id,
        obtainedSource: "ADMIN",
      })
      .returning();
    const [trade] = await db
      .insert(trades)
      .values({
        proposerPlayerId: owner.id,
        recipientPlayerId: recipient.id,
        status: "PENDING",
      })
      .returning();
    if (!trade) throw new Error("Missing trade");
    const items = await db
      .insert(tradeItems)
      .values({
        tradeId: trade.id,
        side: "PROPOSER",
        cardId: card.id,
        quantity: 1,
      })
      .returning();
    for (const operation of ["disable", "enable"] as const) {
      await service.execute(admin, { operation, id: card.id });
      expect((await repository.find(card.id))?.enabled).toBe(
        operation === "enable",
      );
      expect(await db.select().from(cardInstances)).toEqual(copies);
      expect(await db.select().from(tradeItems)).toEqual(items);
    }
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it("lists disabled cards too, with stable name/ID sorting and bounded pages", async () => {
    const created = await Promise.all(
      Array.from({ length: 12 }, () => createCard()),
    );
    await service.execute(admin, {
      operation: "disable",
      id: created[0]?.id ?? missing,
    });
    const sorted = created.map((card) => card.id).sort();
    const first = await service.execute(admin, { operation: "list", page: 1 });
    const second = await service.execute(admin, { operation: "list", page: 2 });
    if (first.kind !== "list" || second.kind !== "list")
      throw new Error("Expected list");
    expect(first.cards.map((card) => card.id)).toEqual(sorted.slice(0, 10));
    expect(first.hasNext).toBe(true);
    expect(second.cards.map((card) => card.id)).toEqual(sorted.slice(10));
    expect(second.hasNext).toBe(false);
    expect(
      [...first.cards, ...second.cards].filter((card) => !card.enabled),
    ).toHaveLength(1);
    expect(
      await service.execute(admin, { operation: "list", page: 3 }),
    ).toMatchObject({ cards: [], hasNext: false });
  });

  it("replaces at the same shared key without changing metadata or identity", async () => {
    const card = await createCard();
    const replacement = { ...image, bytes: Buffer.from("replacement") };
    const result = await service.execute(admin, {
      operation: "replace-image",
      id: card.id,
      image: replacement,
    });
    expect(result).toMatchObject({
      card: {
        id: card.id,
        assetKey: card.assetKey,
        name: card.name,
        rarity: card.rarity,
      },
    });
    expect(storage.put).toHaveBeenLastCalledWith(
      card.assetKey,
      replacement.bytes,
      replacement.contentType,
    );
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it.each(["show", "edit", "enable", "disable", "replace-image"] as const)(
    "reports missing cards for %s",
    async (operation) => {
      await expect(
        service.execute(admin, { operation, id: missing, name: "name", image }),
      ).rejects.toThrow("Card not found");
      expect(storage.put).not.toHaveBeenCalled();
      expect(storage.get).not.toHaveBeenCalled();
    },
  );

  it.each([
    { ...create, name: " " },
    { ...create, rarity: "MYTHIC" },
    { ...create, image: { ...image, bytes: new Uint8Array() } },
    {
      ...create,
      image: { ...image, bytes: new Uint8Array(maxImageBytes + 1) },
    },
    { ...create, image: { ...image, contentType: "text/html" } },
    { operation: "edit", id: missing },
    { operation: "show", id: "bad" },
    { operation: "list", page: 0 },
    { operation: "list", page: 1.5 },
  ])("rejects invalid input before writing", async (request) => {
    await expect(
      service.execute(admin, request as CardRequest),
    ).rejects.toThrow("Invalid card input");
    expect(await repository.list(0, 10)).toEqual([]);
    expect(storage.put).not.toHaveBeenCalled();
  });

  it("does not insert a record when upload fails or update it when replacement fails", async () => {
    storage.put.mockRejectedValueOnce(new Error("S3 failed"));
    await expect(createCard()).rejects.toThrow("S3 failed");
    expect(await repository.list(0, 10)).toEqual([]);
    const card = await createCard();
    storage.put.mockRejectedValueOnce(new Error("S3 failed"));
    await expect(
      service.execute(admin, {
        operation: "replace-image",
        id: card.id,
        image,
      }),
    ).rejects.toThrow("S3 failed");
    expect(await repository.find(card.id)).toEqual(card);
  });

  it("surfaces database failure after upload without deleting a possibly referenced object", async () => {
    vi.spyOn(repository, "create").mockRejectedValueOnce(
      new Error("DB failed"),
    );
    await expect(createCard()).rejects.toThrow("DB failed");
    expect(storage.put).toHaveBeenCalledTimes(1);
    expect(storage.delete).not.toHaveBeenCalled();
  });
});
