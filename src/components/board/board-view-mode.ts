export type BoardViewMode = "columns" | "bybot";

const KEY = "seira.board.view";

export function readBoardViewMode(): BoardViewMode {
  try {
    return localStorage.getItem(KEY) === "bybot" ? "bybot" : "columns";
  } catch {
    return "columns";
  }
}

export function writeBoardViewMode(mode: BoardViewMode): void {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* The choice only lasts for this visit. */
  }
}
