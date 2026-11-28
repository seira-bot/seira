import { describe, expect, it } from "vitest";

import { messageBoxHeight, TRANSCRIPT_END_GAP, transcriptEndPad } from "./composer-dock";

describe("transcriptEndPad", () => {
  it("leaves 24px of clear space above the measured composer", () => {
    expect(TRANSCRIPT_END_GAP).toBe("1.5rem");
    expect(transcriptEndPad(72)).toBe("calc(72px + 1.5rem)");
  });

  it("ceils fractional heights so a subpixel composer cannot eat the gap", () => {
    expect(transcriptEndPad(71.2)).toBe("calc(72px + 1.5rem)");
  });

  it("does not go negative", () => {
    expect(transcriptEndPad(-4)).toBe("calc(0px + 1.5rem)");
  });

  it("uses a one-line empty-composer fallback, not the old two-row slot", () => {
    expect(transcriptEndPad(Number.NaN)).toBe("calc(64px + 1.5rem)");
  });
});

describe("messageBoxHeight", () => {
  it("leaves out what is stacked above the message box, so an open page is not squeezed by attachments", () => {
    expect(messageBoxHeight({ bottom: 900 }, { top: 840 })).toBe(60);
  });

  it("is zero without a message box, and never negative", () => {
    expect(messageBoxHeight({ bottom: 900 }, undefined)).toBe(0);
    expect(messageBoxHeight({ bottom: 900 }, { top: 910 })).toBe(0);
  });
});
