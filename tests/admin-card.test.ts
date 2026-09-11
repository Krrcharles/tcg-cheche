import type { ChatInputCommandInteraction } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adminCardCommand,
  handleAdminCard,
  presentCardResult,
} from "../src/discord/commands/admin-card.js";
import { createAdminGuard } from "../src/domain/administration/admin-guard.js";
import type { CardRepository } from "../src/domain/cards/card.js";
import {
  CardNameConflictError,
  CardService,
} from "../src/domain/cards/card-service.js";

const guild = "123456789012345678";
const admin = "987654321098765432";
const card = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Test",
  rarity: "RARE" as const,
  assetKey: "cards/test",
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function fixture(operation = "show") {
  const repository: CardRepository = {
    create: vi.fn().mockResolvedValue(card),
    find: vi.fn().mockResolvedValue(card),
    list: vi.fn().mockResolvedValue([card]),
    update: vi.fn().mockResolvedValue(card),
  };
  const storage = {
    put: vi.fn(),
    get: vi.fn().mockResolvedValue(Buffer.from("image")),
    delete: vi.fn(),
  };
  const service = new CardService(
    repository,
    storage,
    createAdminGuard({ user_ids: [admin], role_ids: [] }),
  );
  const interaction = {
    guildId: guild,
    commandName: "admin",
    user: { id: admin },
    deferred: false,
    options: {
      getSubcommandGroup: () => "card",
      getSubcommand: () => operation,
      getString: (name: string) =>
        ({ id: card.id, name: "Test", rarity: "RARE" })[name],
      getInteger: () => null,
      getAttachment: vi.fn().mockReturnValue({
        url: "https://cdn.discordapp.com/attachments/test/image.png",
        size: 5,
        contentType: "image/png",
      }),
    },
    deferReply: vi.fn().mockImplementation(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn(),
    reply: vi.fn(),
  };
  return {
    repository,
    storage,
    service,
    interaction,
    run: () =>
      handleAdminCard(
        interaction as unknown as ChatInputCommandInteraction,
        guild,
        service,
      ),
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Discord admin card adapter", () => {
  it("returns a clear name-conflict error for UUID-based editing", async () => {
    const f = fixture("edit");
    vi.mocked(f.repository.update).mockRejectedValueOnce(
      new CardNameConflictError(),
    );
    await f.run();
    expect(f.repository.update).toHaveBeenCalledWith(card.id, {
      name: "Test",
      rarity: "RARE",
    });
    expect(f.interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining(
          "A card with that name already exists",
        ),
      }),
    );
  });
  it.each([
    [Buffer.from([0x89, 0x50, 0x4e, 0x47]), "png"],
    [Buffer.from([0xff, 0xd8, 0xff]), "jpg"],
    [Buffer.from("GIF89a"), "gif"],
    [Buffer.from("RIFF0000WEBP"), "webp"],
  ])(
    "uses the stored image format for the attachment filename",
    (image, extension) => {
      const reply = presentCardResult({ kind: "card", card, image });
      expect(reply.files[0]?.name).toBe(`card-image.${extension}`);
      expect(reply.embeds[0]?.toJSON().image?.url).toBe(
        `attachment://card-image.${extension}`,
      );
    },
  );

  it.each(["edit", "enable", "disable", "list"])(
    "routes %s through the service",
    async (operation) => {
      const f = fixture(operation);
      vi.spyOn(console, "info").mockImplementation(() => {});
      await f.run();
      if (operation === "list")
        expect(f.repository.list).toHaveBeenCalledWith(0, 11);
      else
        expect(f.repository.update).toHaveBeenCalledWith(
          card.id,
          operation === "edit"
            ? { name: "Test", rarity: "RARE" }
            : { enabled: operation === "enable" },
        );
      expect(f.interaction.editReply).toHaveBeenCalledOnce();
    },
  );
  it("registers exactly the seven scoped subcommands, without Discord-role gating", () => {
    const command = adminCardCommand();
    expect(command.name).toBe("admin");
    const group = command.options?.[0];
    expect(group?.name).toBe("card");
    expect(
      group && "options" in group
        ? group.options?.map((option) => option.name)
        : [],
    ).toEqual([
      "create",
      "edit",
      "show",
      "list",
      "enable",
      "disable",
      "replace-image",
    ]);
    expect(command.default_member_permissions).toBeUndefined();
  });

  it("ignores another guild before authorization or any service work", async () => {
    const f = fixture();
    f.interaction.guildId = "111111111111111111";
    await f.run();
    expect(f.repository.find).not.toHaveBeenCalled();
    expect(f.interaction.deferReply).not.toHaveBeenCalled();
    expect(f.interaction.reply).not.toHaveBeenCalled();
  });

  it("rejects non-admins before reading or downloading an image", async () => {
    const f = fixture("create");
    f.interaction.user.id = "111111111111111111";
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await f.run();
    expect(f.interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "You are not authorized to use admin commands.",
      }),
    );
    expect(f.interaction.options.getAttachment).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(f.repository.create).not.toHaveBeenCalled();
  });

  it("defers, calls the service and presents the full record with a private attachment", async () => {
    const f = fixture();
    await f.run();
    expect(f.interaction.deferReply).toHaveBeenCalledOnce();
    expect(f.repository.find).toHaveBeenCalledWith(card.id);
    const reply = f.interaction.editReply.mock.calls[0]?.[0];
    expect(reply.embeds[0].toJSON().fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Asset key", value: card.assetKey }),
      ]),
    );
    expect(reply.files).toHaveLength(1);
    expect(reply.allowedMentions.parse).toEqual([]);
  });

  it.each(["create", "replace-image"])(
    "downloads an attachment for %s and logs the successful mutation",
    async (operation) => {
      const f = fixture(operation);
      const log = vi.spyOn(console, "info").mockImplementation(() => {});
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("image")));
      await f.run();
      expect(f.storage.put).toHaveBeenCalledWith(
        operation === "create"
          ? expect.stringMatching(/^cards\/[0-9a-f-]+$/)
          : card.assetKey,
        new Uint8Array(Buffer.from("image")),
        "image/png",
      );
      expect(log).toHaveBeenCalledWith(
        "Admin card mutation",
        expect.objectContaining({ userId: admin, operation }),
      );
    },
  );

  it.each([
    {
      size: 9 * 1024 * 1024,
      contentType: "image/png",
      url: "https://cdn.discordapp.com/test",
    },
    {
      size: 5,
      contentType: "text/html",
      url: "https://cdn.discordapp.com/test",
    },
    { size: 5, contentType: "image/png", url: "https://example.com/test" },
  ])("rejects unsupported attachments before download", async (attachment) => {
    const f = fixture("create");
    f.interaction.options.getAttachment.mockReturnValue(attachment);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await f.run();
    expect(fetch).not.toHaveBeenCalled();
    expect(f.storage.put).not.toHaveBeenCalled();
    expect(f.interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.any(String) }),
    );
  });

  it("does not expose infrastructure errors in replies", async () => {
    const f = fixture();
    vi.mocked(f.storage.get).mockRejectedValue(new Error("secret endpoint"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await f.run();
    expect(f.interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content:
          "Card operation failed. Check the card record before retrying.",
      }),
    );
  });

  it("renders empty lists and next-page guidance", () => {
    const empty = presentCardResult({
      kind: "list",
      cards: [],
      page: 1,
      hasNext: false,
    });
    expect(empty.embeds[0]?.toJSON().description).toBe(
      "No cards on this page.",
    );
    const page = presentCardResult({
      kind: "list",
      cards: [card],
      page: 1,
      hasNext: true,
    });
    expect(page.embeds[0]?.toJSON().footer?.text).toContain("page:2");
  });
});
