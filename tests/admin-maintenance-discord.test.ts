import { type ChatInputCommandInteraction, MessageFlags } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadGameConfiguration } from "../src/config/game.js";
import {
  adminCommand,
  handleAdminMaintenance,
} from "../src/discord/commands/admin-maintenance.js";
import { createAdminGuard } from "../src/domain/administration/admin-guard.js";
import {
  InsufficientCopiesError,
  type MaintenanceRepository,
  MaintenanceService,
  type MaintenanceTransaction,
} from "../src/domain/administration/maintenance-service.js";
import { rarities } from "../src/domain/cards/card.js";

const guild = "123456789012345678";
const actor = "987654321098765432";
const target = "123456789012345679";
const cardId = "00000000-0000-4000-8000-000000000001";
function fixture(operation = "show") {
  const transaction: MaintenanceTransaction = {
    show: vi.fn().mockResolvedValue({
      playerId: cardId,
      collectedCount: 2,
      totalCopies: 5,
      used: 1,
      pendingTrades: 3,
    }),
    give: vi.fn(),
    remove: vi.fn(),
    resetDaily: vi.fn().mockResolvedValue(2),
  };
  const repository: MaintenanceRepository = {
    withPlayer: vi.fn(async (_user, _create, run) => run(transaction)),
    enabledCards: vi.fn().mockResolvedValue(
      rarities.map((rarity, i) => ({
        id: String(i),
        name: rarity,
        rarity,
        enabled: true,
        assetKey: `cards/${rarity}`,
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
    ),
  };
  const service = new MaintenanceService(
    repository,
    loadGameConfiguration(),
    createAdminGuard({ user_ids: [actor], role_ids: [] }),
    () => 0,
  );
  const interaction = {
    commandName: "admin",
    guildId: guild,
    user: { id: actor },
    deferred: false,
    options: {
      getSubcommandGroup: vi.fn((): string =>
        operation === "simulate" ? "booster" : "player",
      ),
      getSubcommand: vi.fn(() => operation),
      getUser: vi.fn(() => ({ id: target })),
      getString: vi.fn(() => cardId),
      getInteger: vi.fn((name: string) => (name === "count" ? null : 2)),
    },
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn(),
    reply: vi.fn(),
  };
  return {
    transaction,
    repository,
    service,
    interaction,
    run: () =>
      handleAdminMaintenance(
        interaction as unknown as ChatInputCommandInteraction,
        guild,
        service,
      ),
  };
}
afterEach(() => vi.restoreAllMocks());

describe("Discord admin maintenance", () => {
  it("registers all three admin groups together, preserving existing card commands", () => {
    const command = adminCommand();
    expect(command.name).toBe("admin");
    expect(command.default_member_permissions).toBeUndefined();
    expect(command.options.map((o) => o.name)).toEqual([
      "card",
      "player",
      "booster",
    ]);
    const group = command.options.find((o) => o.name === "player");
    expect(
      group && "options" in group ? group.options?.map((o) => o.name) : [],
    ).toEqual(["show", "give-card", "remove-card", "reset-daily"]);
  });

  it.each(["show", "give-card", "remove-card", "reset-daily", "simulate"])(
    "routes %s and replies ephemerally",
    async (operation) => {
      const f = fixture(operation);
      const log = vi.spyOn(console, "info").mockImplementation(() => {});
      await f.run();
      expect(f.interaction.deferReply).toHaveBeenCalledWith({
        flags: MessageFlags.Ephemeral,
      });
      expect(f.interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ allowedMentions: { parse: [] } }),
      );
      if (operation === "simulate") {
        expect(f.repository.withPlayer).not.toHaveBeenCalled();
        expect(f.repository.enabledCards).toHaveBeenCalledOnce();
        const payload = f.interaction.editReply.mock.calls[0]?.[0];
        expect(payload.content).toContain("Simulated 1 standard boosters");
        expect(payload.files[0].name).toBe("booster-simulation.json");
        const report = JSON.parse(payload.files[0].attachment.toString());
        expect(report.cards).toHaveLength(5);
        expect(report.rarityCounts.COMMON).toBe(4);
      } else {
        expect(f.repository.withPlayer).toHaveBeenCalledWith(
          target,
          operation === "give-card",
          expect.any(Function),
        );
        if (operation === "give-card")
          expect(f.transaction.give).toHaveBeenCalledWith(
            cardId,
            2,
            expect.any(Date),
          );
        if (operation === "remove-card")
          expect(f.transaction.remove).toHaveBeenCalledWith(cardId, 2);
      }
      if (operation === "show" || operation === "simulate")
        expect(log).not.toHaveBeenCalled();
      else
        expect(log).toHaveBeenCalledWith(
          "Admin player mutation",
          expect.objectContaining({
            actorUserId: actor,
            targetUserId: target,
            action: operation,
          }),
        );
    },
  );

  it.each(["show", "give-card", "remove-card", "reset-daily", "simulate"])(
    "rejects unauthorized %s before parsing input or accessing persistence",
    async (operation) => {
      const f = fixture(operation);
      f.interaction.user.id = target;
      await f.run();
      expect(f.interaction.options.getSubcommand).not.toHaveBeenCalled();
      expect(f.repository.withPlayer).not.toHaveBeenCalled();
      expect(f.repository.enabledCards).not.toHaveBeenCalled();
      expect(f.interaction.reply).toHaveBeenCalledWith({
        content: "You are not authorized to use admin commands.",
        flags: MessageFlags.Ephemeral,
      });
    },
  );

  it.each(["guild", "command", "group"])(
    "ignores unrelated %s",
    async (kind) => {
      const f = fixture();
      if (kind === "guild") f.interaction.guildId = "other";
      if (kind === "command") f.interaction.commandName = "booster";
      if (kind === "group")
        f.interaction.options.getSubcommandGroup.mockReturnValue("card");
      await f.run();
      expect(f.repository.withPlayer).not.toHaveBeenCalled();
      expect(f.interaction.deferReply).not.toHaveBeenCalled();
    },
  );

  it("renders insufficient-copy errors without logging success", async () => {
    const f = fixture("remove-card");
    vi.mocked(f.transaction.remove).mockRejectedValue(
      new InsufficientCopiesError(),
    );
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    await f.run();
    expect(f.interaction.editReply).toHaveBeenCalledWith({
      content: "The player does not own enough copies of that card.",
      files: [],
    });
    expect(log).not.toHaveBeenCalled();
  });

  it("hides infrastructure errors", async () => {
    const f = fixture();
    vi.mocked(f.repository.withPlayer).mockRejectedValue(
      new Error("secret database URL"),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    await f.run();
    expect(f.interaction.editReply).toHaveBeenCalledWith({
      content: "Admin operation failed. Check player state before retrying.",
      files: [],
    });
  });
});
