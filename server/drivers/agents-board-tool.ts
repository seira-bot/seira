type BoardApi = (path: string, init?: { method: string; body: string }) => Promise<Record<string, unknown>>;

export async function callBoardCloseTool(
  args: Record<string, unknown>,
  api: BoardApi,
  me: { botId: string; threadId: string },
): Promise<{ text: string; isError?: boolean }> {
  const cardId = typeof args.card_id === "string" ? args.card_id.trim() : "";
  if (!cardId) {
    const query = new URLSearchParams({ fromBotId: me.botId, fromThreadId: me.threadId });
    const r = await api(`/api/internal/board-close?${query.toString()}`);
    if (r.error) return { text: `Couldn't list the cards: ${String(r.error)}`, isError: true };
    const cards = Array.isArray(r.cards) ? r.cards.filter((card): card is Record<string, unknown> => Boolean(card) && typeof card === "object") : [];
    if (!cards.length) return { text: "No Needs you cards that you may move to Done." };
    const lines = cards.map((card) => `- ${String(card.title) || "Untitled"} (${String(card.state)}, @${String(card.botName)}) [card id: ${String(card.id)}]`);
    return { text: `Needs you cards you may move to Done:\n${lines.join("\n")}` };
  }
  const reason = typeof args.reason === "string" ? args.reason.trim() : "";
  if (!reason) return { text: "board_close needs a reason (one plain sentence) with card_id.", isError: true };
  const r = await api("/api/internal/board-close", { method: "POST", body: JSON.stringify({ fromBotId: me.botId, fromThreadId: me.threadId, cardId, reason }) });
  if (r.error) return { text: `Couldn't move that card: ${String(r.error)}`, isError: true };
  return { text: `Moved ${String(r.title) || "the card"} to Done as closed. The person sees that you closed it, and why.` };
}
