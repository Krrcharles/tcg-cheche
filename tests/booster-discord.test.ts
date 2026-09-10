import type { ChatInputCommandInteraction } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  boosterCommand,
  handleBooster,
} from "../src/discord/commands/booster.js";
import { presentBoosterOpening } from "../src/discord/presenters/booster.js";
import {
  type BoosterOpening,
  BoosterQuotaError,
} from "../src/domain/boosters/booster-service.js";
import { BoosterUnavailableError } from "../src/domain/boosters/engine.js";

const guild = "123456789012345678";
const user = "987654321098765432";
const status = {
  used: 1,
  limit: 3,
  remaining: 2,
  resetsAt: new Date("2026-09-10T22:00:00Z"),
};
const opening: BoosterOpening = {
  id: "00000000-0000-4000-8000-000000000001",
  openedAt: new Date(),
  status,
  cards: Array.from({ length: 5 }, (_, index) => ({
    id: `00000000-0000-4000-8000-00000000000${index + 1}`,
    name: `Card ${index}`,
    assetKey: `cards/${index}`,
    rarity: index === 4 ? "RARE" : "COMMON",
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  })),
};

function fixture(operation = "open", result = structuredClone(opening)) {
  const service = {
    status: vi.fn().mockResolvedValue(status),
    open: vi.fn().mockResolvedValue(result),
  };
  const storage = { get: vi.fn().mockResolvedValue(Buffer.from("image")) };
  const interaction = {
    guildId: guild,
    commandName: "booster",
    user: { id: user },
    deferred: false,
    options: { getSubcommand: () => operation },
    deferReply: vi.fn().mockImplementation(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn(),
    reply: vi.fn(),
    followUp: vi.fn(),
  };
  return {
    service,
    storage,
    interaction,
    result,
    run: () =>
      handleBooster(
        interaction as unknown as ChatInputCommandInteraction,
        guild,
        service,
        storage,
      ),
  };
}
afterEach(() => vi.restoreAllMocks());

describe("Discord booster adapter", () => {
  it("registers public status and open subcommands", () => {
    const command = boosterCommand();
    expect(command.name).toBe("booster");
    expect(command.options?.map((option) => option.name)).toEqual([
      "status",
      "open",
    ]);
    expect(command.default_member_permissions).toBeUndefined();
  });

  it.each(["other guild", "DM", "other command"])(
    "ignores %s before service access",
    async (kind) => {
      const f = fixture();
      if (kind === "other command") f.interaction.commandName = "admin";
      else f.interaction.guildId = kind === "DM" ? "" : "111111111111111111";
      await f.run();
      expect(f.service.open).not.toHaveBeenCalled();
      expect(f.service.status).not.toHaveBeenCalled();
      expect(f.interaction.deferReply).not.toHaveBeenCalled();
    },
  );

  it("shows status to normal players without opening or loading images", async () => {
    const f = fixture("status");
    await f.run();
    expect(f.service.status).toHaveBeenCalledWith(user);
    expect(f.service.open).not.toHaveBeenCalled();
    expect(f.storage.get).not.toHaveBeenCalled();
    expect(f.interaction.editReply).toHaveBeenCalledWith({
      content: expect.stringContaining("2 / 3 boosters remaining"),
    });
  });

  it("reveals all five cards together with text and private image attachments", async () => {
    const f = fixture();
    await f.run();
    expect(f.service.open).toHaveBeenCalledWith(user);
    expect(f.interaction.deferReply).toHaveBeenCalledWith({});
    expect(f.interaction.editReply).toHaveBeenCalledOnce();
    const reply = f.interaction.editReply.mock.calls[0]?.[0];
    expect(reply.embeds).toHaveLength(5);
    expect(reply.files).toHaveLength(5);
    expect(
      new Set(reply.files.map((file: { name: string }) => file.name)).size,
    ).toBe(5);
    expect(reply.embeds[4].toJSON()).toMatchObject({
      title: "Card 4",
      description: expect.stringContaining("RARE"),
      image: { url: "attachment://booster-5.png" },
    });
    expect(reply.allowedMentions.parse).toEqual([]);
    expect(f.interaction.followUp).not.toHaveBeenCalled();
  });

  it("adds one announcement naming the player and every legendary, including duplicates", async () => {
    const f = fixture();
    f.result.cards = f.result.cards.map((card) => ({
      ...card,
      rarity: "LEGENDARY",
      name: "@everyone Legendary",
    }));
    await f.run();
    expect(f.interaction.followUp).toHaveBeenCalledOnce();
    const announcement = f.interaction.followUp.mock.calls[0]?.[0];
    expect(announcement.content).toContain(`<@${user}>`);
    for (const card of f.result.cards)
      expect(announcement.content).toContain(card.id);
    expect(announcement.allowedMentions.parse).toEqual([]);
  });

  it.each(["quota", "catalogue", "database"])(
    "reports %s failure without images or announcements",
    async (kind) => {
      const f = fixture();
      vi.spyOn(console, "error").mockImplementation(() => {});
      f.service.open.mockRejectedValue(
        kind === "quota"
          ? new BoosterQuotaError({ ...status, used: 3, remaining: 0 })
          : kind === "catalogue"
            ? new BoosterUnavailableError("No enabled cards.")
            : new Error("secret database URL"),
      );
      await f.run();
      expect(f.storage.get).not.toHaveBeenCalled();
      expect(f.interaction.followUp).not.toHaveBeenCalled();
      const reply = f.interaction.editReply.mock.calls[0]?.[0];
      expect(reply.content).not.toContain("secret");
      expect(reply.content).toContain(
        kind === "quota"
          ? "quota"
          : kind === "catalogue"
            ? "No enabled"
            : "Check /booster status",
      );
    },
  );

  it("keeps the saved result visible if an image download fails", async () => {
    const f = fixture();
    f.storage.get.mockRejectedValueOnce(new Error("S3 failed"));
    await f.run();
    const reply = f.interaction.editReply.mock.calls[0]?.[0];
    expect(reply.embeds).toHaveLength(5);
    expect(reply.files).toHaveLength(4);
    expect(reply.embeds[0].toJSON().footer.text).toContain("card is saved");
    expect(f.service.open).toHaveBeenCalledOnce();
  });

  it("falls back to the saved card list if Discord rejects the reveal", async () => {
    const f = fixture();
    vi.spyOn(console, "error").mockImplementation(() => {});
    f.interaction.editReply.mockRejectedValueOnce(new Error("upload failed"));
    await f.run();
    expect(f.interaction.editReply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Your booster was saved"),
      }),
    );
    expect(f.service.open).toHaveBeenCalledOnce();
  });

  it("does not overwrite a successful reveal when the announcement fails", async () => {
    const f = fixture();
    f.result.cards = f.result.cards.map((card) => ({
      ...card,
      rarity: "LEGENDARY",
    }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    f.interaction.followUp.mockRejectedValue(new Error("Discord failed"));
    await f.run();
    expect(f.interaction.editReply).toHaveBeenCalledOnce();
    expect(f.service.open).toHaveBeenCalledOnce();
  });

  it.each([
    [Buffer.from("GIF89a"), "gif"],
    [Buffer.from("RIFF0000WEBP"), "webp"],
    [Buffer.from([0xff, 0xd8]), "jpg"],
    [Buffer.from("PNG"), "png"],
  ])(
    "uses stored image bytes to choose attachment extensions",
    async (bytes, extension) => {
      const result = await presentBoosterOpening(opening, {
        get: async () => bytes,
      });
      expect(result.files[0]?.name).toBe(`booster-1.${extension}`);
    },
  );
});
