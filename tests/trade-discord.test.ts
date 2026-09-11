import {
  type ButtonInteraction,
  ButtonStyle,
  type ChatInputCommandInteraction,
  MessageFlags,
  type ModalSubmitInteraction,
} from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTradeHandlers,
  parseTradeLines,
  tradeCommand,
} from "../src/discord/commands/trade.js";
import {
  presentTrade,
  tradeMessage,
  tradeText,
} from "../src/discord/presenters/trade.js";
import { CardNotFoundError } from "../src/domain/cards/card-service.js";
import { type Trade, TradeError } from "../src/domain/trades/trade-service.js";
import {
  cardA,
  cardB,
  offer,
  outsiderId,
  proposer,
  proposerId,
  recipient,
  recipientId,
} from "./helpers/trades.js";

const guildId = "123456789012345678";
const trade: Trade = {
  id: "00000000-0000-4000-8000-000000000099",
  proposer: { id: proposer, userId: proposerId },
  recipient: { id: recipient, userId: recipientId },
  items: [
    {
      cardId: cardA,
      quantity: 2,
      side: "PROPOSER",
      name: "Card *A* @everyone",
      rarity: "COMMON",
    },
    {
      cardId: cardB,
      quantity: 1,
      side: "RECIPIENT",
      name: "Card B",
      rarity: "RARE",
    },
  ],
  status: "PENDING",
  createdAt: new Date(),
  completedAt: null,
};

function interaction() {
  const value = {
    guildId: guildId as string | null,
    commandName: "trade",
    customId: "",
    user: { id: proposerId },
    deferred: false,
    replied: false,
    options: {
      getString: vi.fn<() => string | null>(() => null),
      getUser: vi.fn(() => ({ id: recipientId })),
    },
    fields: {
      getTextInputValue: vi.fn((side: string): string =>
        side === "proposer" ? "Card A x2" : "Card B x1",
      ),
    },
    showModal: vi.fn(async (modal: unknown) => {
      // Exercise the same builder serialization as the Discord client.
      (modal as { toJSON(): unknown }).toJSON();
      value.replied = true;
    }),
    deferReply: vi.fn(async (_options?: unknown) => {
      value.deferred = true;
    }),
    deferUpdate: vi.fn(async () => {
      value.deferred = true;
    }),
    reply: vi.fn(),
    editReply: vi.fn(),
    followUp: vi.fn(),
  };
  return value;
}
function fixture() {
  const service = {
    create: vi.fn().mockResolvedValue(trade),
    show: vi.fn().mockResolvedValue(trade),
    act: vi.fn().mockResolvedValue({ ...trade, status: "COMPLETED" }),
  };
  const collections = {
    detail: vi.fn(async (_userId: string, name: string) => ({
      cardId: name.toLowerCase() === "card a" ? cardA : cardB,
      name: name.toLowerCase() === "card a" ? "Card A" : "Card B",
      rarity: "COMMON" as const,
      assetKey: "cards/a",
      ownedCount: 2,
    })),
  };
  const handlers = createTradeHandlers(guildId, service, collections);
  const command = (i: ReturnType<typeof interaction>) =>
    handlers.command(i as unknown as ChatInputCommandInteraction);
  const modal = (i: ReturnType<typeof interaction>) =>
    handlers.modal(i as unknown as ModalSubmitInteraction);
  const button = (i: ReturnType<typeof interaction>) =>
    handlers.button(i as unknown as ButtonInteraction);
  async function draft() {
    const start = interaction();
    await command(start);
    const form = start.showModal.mock.calls[0]?.[0] as {
      data: { custom_id: string };
    };
    const submit = interaction();
    submit.customId = form.data.custom_id;
    await modal(submit);
    const preview = submit.editReply.mock.calls[0]?.[0];
    const buttons = preview.components[0].toJSON().components as {
      custom_id: string;
    }[];
    return {
      submit,
      sendId: buttons[0]?.custom_id ?? "",
      editId: buttons[1]?.custom_id ?? "",
    };
  }
  return { service, collections, handlers, command, modal, button, draft };
}
afterEach(() => vi.restoreAllMocks());

describe("Discord trading", () => {
  it("aggregates repeated resolved names on both sides before persisting UUID quantities", async () => {
    const f = fixture();
    const start = interaction();
    await f.command(start);
    const form = start.showModal.mock.calls[0]?.[0] as {
      toJSON(): { custom_id: string };
    };
    const submit = interaction();
    submit.customId = form.toJSON().custom_id;
    submit.fields.getTextInputValue.mockImplementation((side) =>
      side === "proposer" ? "Card A x1\ncard a x1" : "card b x1\nCard B x2",
    );
    await f.modal(submit);
    const preview = submit.editReply.mock.calls[0]?.[0];
    expect(preview.content).toContain("Card A | COMMON | x2");
    expect(preview.content).toContain("Card B | COMMON | x3");
    const send = interaction();
    send.customId = preview.components[0].toJSON().components[0].custom_id;
    await f.button(send);
    expect(f.service.create).toHaveBeenCalledExactlyOnceWith(
      proposerId,
      recipientId,
      {
        proposer: [{ cardId: cardA, quantity: 2 }],
        recipient: [{ cardId: cardB, quantity: 3 }],
      },
    );
  });
  it.each(["proposer", "recipient"])(
    "rejects unknown names on the %s side before proposal persistence",
    async (side) => {
      const f = fixture();
      const start = interaction();
      await f.command(start);
      const form = start.showModal.mock.calls[0]?.[0] as {
        toJSON(): { custom_id: string };
      };
      const submit = interaction();
      submit.customId = form.toJSON().custom_id;
      if (side === "recipient")
        f.collections.detail.mockResolvedValueOnce({
          cardId: cardA,
          name: "Card A",
          rarity: "COMMON",
          assetKey: "cards/a",
          ownedCount: 2,
        });
      f.collections.detail.mockRejectedValueOnce(new CardNotFoundError());
      await f.modal(submit);
      expect(submit.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: "Card not found.", components: [] }),
      );
      expect(f.service.create).not.toHaveBeenCalled();
    },
  );

  it("registers a normal-player entry point and a saved-ID recovery option", () => {
    expect(tradeCommand()).toMatchObject({
      name: "trade",
      options: [{ name: "player" }, { name: "id" }],
    });
    expect(tradeCommand().default_member_permissions).toBeUndefined();
  });
  it.each([null, "another guild"])(
    "ignores commands and components from %s",
    async (guild) => {
      const f = fixture();
      const i = interaction();
      i.guildId = guild;
      i.customId = `trade:accept:${trade.id}`;
      await f.command(i);
      await f.button(i);
      await f.modal(i);
      expect(f.service.act).not.toHaveBeenCalled();
      expect(i.reply).not.toHaveBeenCalled();
      expect(i.showModal).not.toHaveBeenCalled();
    },
  );
  it("ignores unrelated commands, buttons and modals", async () => {
    const f = fixture();
    const i = interaction();
    i.commandName = "booster";
    i.customId = "collection:other";
    await f.command(i);
    await f.button(i);
    await f.modal(i);
    expect(i.reply).not.toHaveBeenCalled();
    expect(i.deferUpdate).not.toHaveBeenCalled();
  });
  it("rejects self-trading before opening a form", async () => {
    const f = fixture();
    const i = interaction();
    i.options.getUser.mockReturnValue({ id: proposerId });
    await f.command(i);
    expect(i.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("yourself"),
        flags: MessageFlags.Ephemeral,
      }),
    );
    expect(i.showModal).not.toHaveBeenCalled();
  });
  it("previews named quantities privately, then saves once and posts public pending actions", async () => {
    const f = fixture();
    const draft = await f.draft();
    expect(draft.submit.deferReply).toHaveBeenCalledWith({
      flags: MessageFlags.Ephemeral,
    });
    expect(f.service.create).not.toHaveBeenCalled();
    expect(f.collections.detail).toHaveBeenCalledWith(proposerId, "Card A");
    expect(f.collections.detail).toHaveBeenCalledWith(recipientId, "Card B");
    expect(JSON.stringify(draft.submit.editReply.mock.calls)).not.toContain(
      cardA,
    );
    expect(JSON.stringify(draft.submit.editReply.mock.calls)).not.toContain(
      cardB,
    );
    const send = interaction();
    send.customId = draft.sendId;
    await f.button(send);
    expect(f.service.create).toHaveBeenCalledExactlyOnceWith(
      proposerId,
      recipientId,
      offer,
    );
    expect(send.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining(trade.id),
        components: [],
      }),
    );
    expect(send.followUp).toHaveBeenCalledWith(presentTrade(trade));
    await f.button(send);
    expect(f.service.create).toHaveBeenCalledOnce();
  });
  it("edits unsent drafts and invalidates older previews", async () => {
    const f = fixture();
    const draft = await f.draft();
    const edit = interaction();
    edit.customId = draft.editId;
    await f.button(edit);
    const form = edit.showModal.mock.calls[0]?.[0] as {
      toJSON(): { custom_id: string; components: unknown[] };
    };
    expect(JSON.stringify(form.toJSON())).toContain("Card A x2");
    expect(JSON.stringify(form.toJSON())).not.toContain(cardA);
    const submit = interaction();
    submit.customId = form.toJSON().custom_id;
    await f.modal(submit);
    const stale = interaction();
    stale.customId = draft.sendId;
    await f.button(stale);
    expect(f.service.create).not.toHaveBeenCalled();
    expect(stale.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("no longer active"),
      }),
    );
  });
  it.each(["outsider", "restart"])(
    "rejects draft controls after %s",
    async (kind) => {
      const f = fixture();
      const draft = await f.draft();
      const send = interaction();
      send.customId = draft.sendId;
      if (kind === "outsider") send.user.id = outsiderId;
      await (kind === "restart" ? fixture() : f).button(send);
      expect(f.service.create).not.toHaveBeenCalled();
      expect(send.reply).toHaveBeenCalled();
    },
  );
  it("guards simultaneous sends of one draft", async () => {
    const f = fixture();
    const draft = await f.draft();
    let complete: ((value: Trade) => void) | undefined;
    f.service.create.mockReturnValue(
      new Promise<Trade>((resolve) => {
        complete = resolve;
      }),
    );
    const first = interaction();
    first.customId = draft.sendId;
    const pending = f.button(first);
    const second = interaction();
    second.customId = draft.sendId;
    await f.button(second);
    expect(second.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("being processed"),
      }),
    );
    complete?.(trade);
    await pending;
    expect(f.service.create).toHaveBeenCalledOnce();
  });
  it("leaves a recoverable saved trade if public delivery fails without recreating it", async () => {
    const f = fixture();
    const draft = await f.draft();
    const send = interaction();
    send.customId = draft.sendId;
    send.followUp.mockRejectedValueOnce(new Error("Discord unavailable"));
    await f.button(send);
    expect(send.followUp).toHaveBeenLastCalledWith(
      expect.objectContaining({
        content: expect.stringContaining(`Use /trade id:${trade.id}`),
        flags: MessageFlags.Ephemeral,
      }),
    );
    await f.button(send);
    expect(f.service.create).toHaveBeenCalledOnce();
  });
  it.each(["accept", "reject", "cancel"])(
    "routes %s with the actual actor and updates the saved result",
    async (action) => {
      const f = fixture();
      const i = interaction();
      i.customId = `trade:${action}:${trade.id}`;
      i.user.id = recipientId;
      await f.button(i);
      expect(f.service.act).toHaveBeenCalledExactlyOnceWith(
        recipientId,
        trade.id,
        action,
      );
      expect(i.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ components: [] }),
      );
    },
  );
  it("keeps controls on stale ownership or authorization failure", async () => {
    const f = fixture();
    f.service.act.mockRejectedValue(
      new TradeError("Only the recipient can accept or reject this trade."),
    );
    const i = interaction();
    i.customId = `trade:accept:${trade.id}`;
    await f.button(i);
    expect(i.editReply).not.toHaveBeenCalled();
    expect(i.followUp).toHaveBeenCalledWith(
      expect.objectContaining({ flags: MessageFlags.Ephemeral }),
    );
  });
  it("reports committed status after a message update fails", async () => {
    const f = fixture();
    const i = interaction();
    i.customId = `trade:accept:${trade.id}`;
    i.editReply.mockRejectedValue(new Error("offline"));
    await f.button(i);
    expect(i.followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("is completed"),
        flags: MessageFlags.Ephemeral,
      }),
    );
    expect(f.service.act).toHaveBeenCalledOnce();
  });
  it("reopens persisted proposals without a draft session", async () => {
    const f = fixture();
    const i = interaction();
    i.options.getString.mockReturnValue(trade.id);
    i.options.getUser = vi.fn(
      () => null,
    ) as unknown as typeof i.options.getUser;
    await f.command(i);
    expect(f.service.show).toHaveBeenCalledWith(trade.id);
    expect(i.editReply).toHaveBeenCalledWith(presentTrade(trade));
  });
  it("rejects malformed controls and hides unexpected errors", async () => {
    const f = fixture();
    const i = interaction();
    i.customId = "trade:accept:invalid";
    await f.button(i);
    expect(f.service.act).not.toHaveBeenCalled();
    vi.spyOn(console, "error").mockImplementation(() => {});
    f.service.act.mockRejectedValue(new Error("secret database URL"));
    i.customId = `trade:accept:${trade.id}`;
    await f.button(i);
    expect(JSON.stringify(i.followUp.mock.calls)).not.toContain("secret");
  });
});

describe("trade rendering and form parsing", () => {
  it("parses card quantities and rejects ambiguous lines", () => {
    expect(
      parseTradeLines(
        "\n Kevin au Buffalo Grill x2\r\nThomas Crocs x1\nCard x2 X3\n",
      ),
    ).toEqual([
      { name: "Kevin au Buffalo Grill", quantity: 2 },
      { name: "Thomas Crocs", quantity: 1 },
      { name: "Card x2", quantity: 3 },
    ]);
    for (const input of [
      "Card x-1",
      "Card x0",
      "Card x1.5",
      "Card x1 extra",
      " x1",
      "Card x9007199254740992",
      `${"A".repeat(101)} x1`,
      "name 2",
    ])
      expect(() => parseTradeLines(input)).toThrow("one Card Name xN");
    expect(parseTradeLines(" \n\r\n")).toEqual([]);
  });
  it("shows both sides safely and removes controls for every terminal status", () => {
    expect(tradeText(proposerId, recipientId, trade.items)).toContain(
      "Card \\*A\\* @everyone | COMMON | x2",
    );
    for (const status of [
      "PENDING",
      "COMPLETED",
      "REJECTED",
      "CANCELLED",
    ] as const) {
      const rendered = presentTrade({ ...trade, status });
      expect(rendered.allowedMentions.parse).toEqual([]);
      expect(rendered.content).toContain(status);
      expect(rendered.content).toContain(trade.id);
      expect(JSON.stringify(rendered)).not.toContain(cardA);
      expect(JSON.stringify(rendered)).not.toContain(cardB);
      expect(rendered.components).toHaveLength(status === "PENDING" ? 1 : 0);
      for (const row of rendered.components)
        for (const button of row.toJSON().components)
          if ("custom_id" in button)
            expect(button.custom_id.length).toBeLessThanOrEqual(100);
    }
  });
  it("attaches oversized offers in full while keeping controls within Discord limits", () => {
    const text = "long offer\n".repeat(1000);
    const rendered = tradeMessage("Preview", text, [
      { id: "trade:send:id", label: "Send", style: ButtonStyle.Success },
    ]);
    expect(rendered.content.length).toBeLessThanOrEqual(2000);
    expect(rendered.files[0]?.attachment).toEqual(
      Buffer.from(`Preview\n\n${text}`),
    );
    expect(rendered.components).toHaveLength(1);
  });
});
