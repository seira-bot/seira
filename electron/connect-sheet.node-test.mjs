import assert from "node:assert/strict";
import test from "node:test";
import { openConnectSheet } from "./connect-sheet.mjs";

const page = ({ destroyed = false, loading = false } = {}) => {
  const sent = [];
  return { sent, isDestroyed: () => destroyed, webContents: { isLoadingMainFrame: () => loading, send: channel => sent.push(channel) } };
};

test("a loaded local page gets the Connect sheet and Settings stays closed", () => {
  const win = page(), opened = [];
  assert.equal(openConnectSheet({ window: () => win, isLocal: () => true, fallback: () => opened.push("settings") }), true);
  assert.deepEqual([win.sent, opened], [["workspaces:connect-server"], []]);
});

test("without a window that can show the sheet, Settings opens as before", () => {
  for (const win of [null, page({ destroyed: true }), page({ loading: true })]) {
    const opened = [];
    assert.equal(openConnectSheet({ window: () => win, isLocal: () => true, fallback: () => opened.push("settings") }), false);
    assert.deepEqual([win?.sent ?? [], opened], [[], ["settings"]]);
  }
});

test("a hosted page is not asked to show the sheet", () => {
  const win = page(), opened = [];
  assert.equal(openConnectSheet({ window: () => win, isLocal: () => false, fallback: () => opened.push("settings") }), false);
  assert.deepEqual([win.sent, opened], [[], ["settings"]]);
});
