import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { VisibleSet, type ResolvedGrant, type Viewer } from "../bot-visibility.ts";
import { readBody } from "../harness/http.ts";
import { hiddenThreadRefusal, NO_SUCH_CONVERSATION } from "./team-private.ts";

const ADA: Viewer = { kind: "member", email: "ada@acme.test" };
const bots = [
  { id: "sales", threadId: "t-sales", section: "Sales" },
  { id: "fin", threadId: "t-fin", section: "Finance" },
];
const grantOf = (items: Record<string, "view" | "chat">): ResolvedGrant => ({ departments: new Map(), bots: new Map(Object.entries(items)) });
const visibleFor = (viewer: Viewer, grant: ResolvedGrant | null) => new VisibleSet(bots, [], viewer, undefined, undefined, grant);
const ask = (visible: VisibleSet, threadId: string, selected?: (botId: string) => string | undefined) =>
  hiddenThreadRefusal(new PassThrough() as unknown as IncomingMessage, "/api/bots/sales/messages", new URLSearchParams({ threadId }), visible, selected ?? (() => undefined));

describe("a named conversation off a Team Cloud", () => {
  const limited = visibleFor(ADA, grantOf({ sales: "chat" }));

  it("answers 'no such conversation' for a conversation of a bot outside the member's grant", () => {
    expect(ask(limited, "t-fin")).toBe(NO_SUCH_CONVERSATION);
  });

  it("lets a conversation of a granted bot through", () => {
    expect(ask(limited, "t-sales")).toBeNull();
  });

  it("checks the conversation a body names, and the selected conversation when the body names none", async () => {
    const stream = new PassThrough();
    hiddenThreadRefusal(stream as unknown as IncomingMessage, "/api/bots/sales/messages", new URLSearchParams(), limited, () => undefined);
    const read = readBody(stream as unknown as IncomingMessage);
    stream.end(JSON.stringify({ threadId: "t-fin" }));
    await expect(read).rejects.toMatchObject({ status: 404, message: NO_SUCH_CONVERSATION });

    const bare = new PassThrough();
    hiddenThreadRefusal(bare as unknown as IncomingMessage, "/api/bots/sales/messages", new URLSearchParams(), limited, () => "t-fin");
    const bareRead = readBody(bare as unknown as IncomingMessage);
    bare.end(JSON.stringify({ text: "hi" }));
    await expect(bareRead).rejects.toMatchObject({ status: 404 });
  });

  it("passes a member without a grant, and an admin who sees everything", () => {
    expect(ask(visibleFor(ADA, null), "t-fin")).toBeNull();
    expect(ask(visibleFor({ kind: "all" }, null), "t-fin")).toBeNull();
  });
});
