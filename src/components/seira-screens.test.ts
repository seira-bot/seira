import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (file: string) => readFileSync(new URL(`./${file}`, import.meta.url), "utf8");

// Each screen with an empty, waiting, error or success moment draws Seira's character, and never a stock icon or a mouse.
const SCREENS: Record<string, RegExp> = {
  "ChatEmptyState.tsx": /<BotCharacter\b/,
  "RoomChiefAbsent.tsx": /<SeiraCharacter state="attention"/,
  "ChatErrorBanner.tsx": /<SeiraCharacter state="sad"/,
  "ChatView.tsx": /<TurnFace\b/,
  "GroupView.tsx": /<TurnFace\b/,
  "inbox/InboxPanel.tsx": /<SeiraCharacter state="sleep"/,
  "inbox/InboxCard.tsx": /<SeiraCharacter state="happy"/,
  "SearchResults.tsx": /<SeiraCharacter state="idle"/,
  "FilesView.tsx": /<SeiraCharacter state="sleep"/,
  "team-files/TeamFilesPage.tsx": /<SeiraCharacter state="sleep"/,
  "bot-panel/LibraryTab.tsx": /<SeiraCharacter state="sleep"/,
  "TeamLibraryPanel.tsx": /<SeiraCharacter state="idle"/,
  "AboutDialog.tsx": /<SeiraCharacter state="greet"/,
  "VaultSettings.tsx": /<SeiraCharacter state="sleep"/,
  "UsageSection.tsx": /<SeiraCharacter state="sleep"/,
  "ArchivedBotsPanel.tsx": /<SeiraCharacter state="sad"/,
  "TriggersPage.tsx": /<SeiraCharacter state="sleep"/,
  "published-apps/PublishedAppsPage.tsx": /<SeiraCharacter state="sleep"/,
  "announcements/AnnouncementsPage.tsx": /<SeiraCharacter state="sleep"/,
  "whats-new/WhatsNewPopup.tsx": /<SeiraCharacter state="happy"/,
  "HomeScreen.tsx": /<SeiraCharacter state=\{homeCharacterState/,
  "LiveConnectionStrip.tsx": /<SeiraCharacter state=/,
  "PageBoundary.tsx": /<SeiraCharacter state="sad"/,
};

describe("screens with an empty, waiting, error or success moment", () => {
  for (const [file, character] of Object.entries(SCREENS)) {
    it(`${file} shows Seira's character`, () => {
      expect(source(file)).toMatch(character);
    });
  }

  it("the sidebar's stacked faces are bot avatars, which wear Seira unless the person chose another body", () => {
    expect(source("StackedMauses.tsx")).toContain("<BotAvatar");
    expect(source("StackedMauses.tsx")).not.toMatch(/steel-body|mausbot-steel/);
  });
});
