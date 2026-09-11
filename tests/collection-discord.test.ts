import {
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  ComponentType,
  MessageFlags,
} from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cardCommand,
  collectionCommand,
  handleCardAutocomplete,
  handleCollectionButton,
  handleCollectionCommand,
} from "../src/discord/commands/collection.js";
import {
  type CollectionState,
  collectionControls,
  collectionCustomId,
  parseCollectionCustomId,
} from "../src/discord/components/collection.js";
import {
  presentCardDetail,
  presentCollection,
} from "../src/discord/presenters/collection.js";
import { CardNotFoundError } from "../src/domain/cards/card-service.js";
import type { CollectionPage } from "../src/domain/collections/collection-service.js";

const guild = "123456789012345678";
const viewerId = "987654321098765432";
const targetId = "987654321098765433";
const state: CollectionState = {
  viewerId,
  userId: targetId,
  sort: "quantity",
  mode: "gallery",
  page: 2,
};
const page: CollectionPage = {
  userId: targetId,
  sort: "quantity",
  page: 2,
  pageCount: 3,
  catalogueCount: 50,
  collectedCount: 21,
  totalCopies: 80,
  entries: Array.from({ length: 10 }, (_, index) => ({
    cardId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    name: `Card *${index}* @everyone`,
    assetKey: `cards/${index}`,
    rarity: "RARE",
    ownedCount: index + 1,
  })),
};
const card =
  page.entries[0] ??
  (() => {
    throw new Error("Missing fixture card");
  })();

function fixture(
  commandName = "collection",
  target: string | undefined = targetId,
) {
  const service = {
    list: vi.fn().mockResolvedValue(page),
    detail: vi.fn().mockResolvedValue(card),
  };
  const storage = { get: vi.fn().mockResolvedValue(Buffer.from("image")) };
  const interaction = {
    guildId: guild as string | null,
    commandName,
    customId: collectionCustomId(state),
    user: { id: viewerId },
    deferred: false,
    options: {
      getUser: vi.fn(() => (target ? { id: target } : null)),
      getString: vi.fn(() => card.name),
    },
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    deferUpdate: vi.fn(async () => {
      interaction.deferred = true;
    }),
    reply: vi.fn(),
    editReply: vi.fn(),
    followUp: vi.fn(),
  };
  return {
    service,
    storage,
    interaction,
    command: () =>
      handleCollectionCommand(
        interaction as unknown as ChatInputCommandInteraction,
        guild,
        service,
        storage,
      ),
    button: () =>
      handleCollectionButton(
        interaction as unknown as ButtonInteraction,
        guild,
        service,
        storage,
      ),
  };
}
afterEach(() => vi.restoreAllMocks());

describe("card name autocomplete", () => {
  function autocomplete(
    guildId: string | null = guild,
    commandName = "card",
    name = "name",
  ) {
    return {
      guildId,
      commandName,
      options: { getFocused: vi.fn(() => ({ name, value: "cArD" })) },
      respond: vi.fn(),
    };
  }
  it("returns at most 25 name choices with their stored casing and no IDs", async () => {
    const names = Array.from({ length: 30 }, (_, i) => `Card ${i}`);
    const service = { names: vi.fn().mockResolvedValue(names) };
    const i = autocomplete();
    await handleCardAutocomplete(
      i as unknown as AutocompleteInteraction,
      guild,
      service,
    );
    expect(service.names).toHaveBeenCalledExactlyOnceWith("cArD", 25);
    expect(i.respond).toHaveBeenCalledExactlyOnceWith(
      names.slice(0, 25).map((name) => ({ name, value: name })),
    );
  });
  it.each([
    [null, "card", "name"],
    ["other", "card", "name"],
    [guild, "admin", "name"],
    [guild, "card", "other"],
  ])(
    "ignores unrelated autocomplete %s %s %s",
    async (guildId, command, name) => {
      const i = autocomplete(guildId, command ?? "", name ?? "");
      const service = { names: vi.fn() };
      await handleCardAutocomplete(
        i as unknown as AutocompleteInteraction,
        guild,
        service,
      );
      expect(service.names).not.toHaveBeenCalled();
      expect(i.respond).not.toHaveBeenCalled();
    },
  );
  it("responds with no choices on no matches or query failure without exposing errors", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const service = {
      names: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockRejectedValueOnce(new Error("secret URL")),
    };
    for (let n = 0; n < 2; n++) {
      const i = autocomplete();
      await handleCardAutocomplete(
        i as unknown as AutocompleteInteraction,
        guild,
        service,
      );
      expect(i.respond).toHaveBeenCalledExactlyOnceWith([]);
    }
  });
});

describe("collection commands and navigation", () => {
  it("registers normal-player commands with optional targets and an autocompleted card name", () => {
    expect(collectionCommand()).toMatchObject({
      name: "collection",
      options: [{ name: "player" }],
    });
    expect(cardCommand()).toMatchObject({
      name: "card",
      options: [
        { name: "name", required: true, autocomplete: true },
        { name: "player" },
      ],
    });
    expect(collectionCommand().default_member_permissions).toBeUndefined();
    expect(cardCommand().default_member_permissions).toBeUndefined();
  });

  it.each(["other guild", "DM", "other command"])(
    "ignores %s",
    async (kind) => {
      const f = fixture();
      if (kind === "other guild") f.interaction.guildId = "other";
      if (kind === "DM") f.interaction.guildId = null;
      if (kind === "other command") {
        f.interaction.commandName = "booster";
        f.interaction.customId = "other:control";
      }
      await f.command();
      await f.button();
      expect(f.service.list).not.toHaveBeenCalled();
      expect(f.service.detail).not.toHaveBeenCalled();
      expect(f.interaction.reply).not.toHaveBeenCalled();
    },
  );

  it.each([targetId, ""])(
    "opens the default list for target %s or self without fetching images",
    async (target) => {
      const f = fixture("collection", target);
      await f.command();
      expect(f.service.list).toHaveBeenCalledWith({
        viewerId,
        userId: target || viewerId,
        sort: "rarity",
        mode: "list",
        page: 1,
      });
      expect(f.interaction.deferReply).toHaveBeenCalledOnce();
      expect(f.storage.get).not.toHaveBeenCalled();
      expect(f.interaction.editReply).toHaveBeenCalledOnce();
    },
  );

  it("preserves target, page and sort when switching modes and navigating", async () => {
    const controls = collectionControls(page, state);
    const navigation = controls[0]?.toJSON().components;
    if (!navigation) throw new Error("Missing navigation");
    const states = navigation.map((button) =>
      "custom_id" in button
        ? parseCollectionCustomId(button.custom_id)
        : undefined,
    );
    expect(states).toEqual([
      { ...state, page: 1 },
      { ...state, page: 3 },
      { ...state, mode: "list" },
    ]);
    const sorts = controls[1]?.toJSON().components;
    expect(
      sorts?.map((button) =>
        "custom_id" in button
          ? parseCollectionCustomId(button.custom_id)
          : undefined,
      ),
    ).toEqual(
      ["rarity", "name", "quantity"].map((sort) => ({
        ...state,
        sort,
        page: 1,
      })),
    );
    const f = fixture();
    await f.button();
    expect(f.interaction.deferUpdate).toHaveBeenCalledOnce();
    expect(f.service.list).toHaveBeenCalledWith(state);
    expect(f.storage.get).toHaveBeenCalledTimes(10);
    expect(f.interaction.editReply).toHaveBeenCalledOnce();
    expect(f.interaction.reply).not.toHaveBeenCalled();
  });

  it("disables boundary navigation and emits unique custom IDs within Discord's limit", () => {
    for (const current of [1, 3]) {
      const rows = collectionControls(
        { ...page, page: current },
        { ...state, page: current },
      );
      const buttons = rows.flatMap((row) => row.toJSON().components);
      expect(buttons[0]).toMatchObject({ disabled: current === 1 });
      expect(buttons[1]).toMatchObject({ disabled: current === 3 });
      const ids = buttons.map((button) =>
        "custom_id" in button ? button.custom_id : "",
      );
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(id.length).toBeLessThanOrEqual(100);
    }
    expect(
      collectionCustomId(
        {
          ...state,
          viewerId: "9".repeat(20),
          userId: "8".repeat(20),
          page: 1_000_000,
        },
        "quantity",
      ).length,
    ).toBeLessThanOrEqual(100);
  });

  it.each(["outsider", "malformed"])(
    "rejects %s controls before querying",
    async (kind) => {
      const f = fixture();
      if (kind === "outsider") f.interaction.user.id = targetId;
      else f.interaction.customId = "collection:broken";
      await f.button();
      expect(f.service.list).not.toHaveBeenCalled();
      expect(f.interaction.deferUpdate).not.toHaveBeenCalled();
      expect(f.interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ flags: MessageFlags.Ephemeral }),
      );
    },
  );

  it.each([
    "collection:1:2:unknown:list:1:next",
    "collection:1:2:rarity:unknown:1:next",
    "collection:1:2:rarity:list:0:next",
    "collection:1:2:rarity:list:1:next:extra",
    "collection:1:2:rarity:list:1",
  ])("rejects malformed state %s", (id) => {
    expect(parseCollectionCustomId(id)).toBeUndefined();
  });

  it.each([targetId, ""])(
    "shows detail for target %s or self",
    async (target) => {
      const f = fixture("card", target);
      await f.command();
      expect(f.service.detail).toHaveBeenCalledWith(
        target || viewerId,
        card.name,
      );
      expect(f.storage.get).toHaveBeenCalledWith(card.assetKey);
      expect(f.service.list).not.toHaveBeenCalled();
    },
  );

  it("reports unknown cards without reading storage", async () => {
    const f = fixture("card");
    f.service.detail.mockRejectedValue(new CardNotFoundError());
    await f.command();
    expect(f.storage.get).not.toHaveBeenCalled();
    expect(
      f.interaction.editReply.mock.calls[0]?.[0].components[0].toJSON().content,
    ).toBe("Card not found.");
  });

  it("keeps previous controls on query failure and hides internal errors", async () => {
    const f = fixture();
    vi.spyOn(console, "error").mockImplementation(() => {});
    f.service.list.mockRejectedValue(new Error("secret database URL"));
    await f.button();
    expect(f.interaction.editReply).not.toHaveBeenCalled();
    expect(f.interaction.followUp).toHaveBeenCalledWith({
      content: "Collection request failed. Please try again.",
      flags: MessageFlags.Ephemeral,
    });
  });
});

describe("collection presenters", () => {
  it("renders the same collection text in both modes with ten gallery images from storage", async () => {
    const storage = { get: vi.fn().mockResolvedValue(Buffer.from("image")) };
    const list = await presentCollection(
      page,
      { ...state, mode: "list" },
      storage,
    );
    expect(storage.get).not.toHaveBeenCalled();
    const gallery = await presentCollection(page, state, storage);
    expect(list.components[0]?.toJSON()).toEqual(
      gallery.components[0]?.toJSON(),
    );
    const text = JSON.stringify(list.components[0]?.toJSON());
    expect(text).toContain("21 / 50 cards collected");
    expect(text).toContain("80 total copies");
    expect(text).toContain("Page 2 / 3");
    expect(gallery.flags).toBe(MessageFlags.IsComponentsV2);
    expect(gallery.files).toHaveLength(10);
    const media = gallery.components
      .map((component) => component.toJSON())
      .find((component) => component.type === ComponentType.MediaGallery);
    expect(media?.items).toHaveLength(10);
    expect(media?.items[0]).toMatchObject({
      media: { url: "attachment://collection-1.png" },
      description: expect.stringContaining("RARE | 1 copies"),
    });
    for (const entry of page.entries)
      expect(storage.get).toHaveBeenCalledWith(entry.assetKey);
    expect(gallery.allowedMentions.parse).toEqual([]);
    for (const entry of page.entries) {
      expect(JSON.stringify(list)).not.toContain(entry.cardId);
      expect(JSON.stringify(gallery)).not.toContain(entry.cardId);
    }
    // Updates explicitly discard attachments from the previous page/mode.
    expect(list.attachments).toEqual([]);
    expect(gallery.attachments).toEqual([]);
  });

  it("renders empty collections with controls but no gallery or downloads", async () => {
    const storage = { get: vi.fn() };
    const result = await presentCollection(
      {
        ...page,
        entries: [],
        collectedCount: 0,
        totalCopies: 0,
        page: 1,
        pageCount: 1,
      },
      state,
      storage,
    );
    expect(
      JSON.stringify(result.components.map((component) => component.toJSON())),
    ).toContain("No cards collected yet");
    expect(storage.get).not.toHaveBeenCalled();
    expect(result.files).toHaveLength(0);
  });

  it.each([1, 10])(
    "preserves card text and controls when %s images fail",
    async (failures) => {
      const storage = { get: vi.fn().mockResolvedValue(Buffer.from("image")) };
      for (let i = 0; i < failures; i++)
        storage.get.mockRejectedValueOnce(new Error("secret S3 URL"));
      const result = await presentCollection(page, state, storage);
      const json = JSON.stringify(
        result.components.map((component) => component.toJSON()),
      );
      expect(result.files).toHaveLength(10 - failures);
      expect(json).toContain("Images temporarily unavailable");
      for (const entry of page.entries)
        expect(json).not.toContain(entry.cardId);
      expect(json).toContain("Previous");
      expect(json).not.toContain("secret");
    },
  );

  it.each([
    [Buffer.from("GIF89a"), "gif"],
    [Buffer.from("RIFF0000WEBP"), "webp"],
    [Buffer.from([0xff, 0xd8]), "jpg"],
    [Buffer.from("PNG"), "png"],
  ])(
    "renders detail image with the stored format %s",
    async (bytes, extension) => {
      const result = await presentCardDetail(card, targetId, {
        get: async () => bytes as Buffer,
      });
      expect(result.files[0]?.name).toBe(`collection-1.${extension}`);
      expect(JSON.stringify(result)).not.toContain(card.cardId);
      expect(result.components[0]?.toJSON()).toMatchObject({
        content: expect.stringContaining("RARE | 1 copies"),
      });
    },
  );

  it("keeps details readable when the image is unavailable", async () => {
    const result = await presentCardDetail(card, viewerId, {
      get: async () => {
        throw new Error("missing");
      },
    });
    expect(result.files).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(card.cardId);
    expect(
      JSON.stringify(result.components.map((component) => component.toJSON())),
    ).toContain("Image temporarily unavailable");
  });
});
