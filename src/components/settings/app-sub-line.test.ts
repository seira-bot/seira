import { describe, expect, it } from "vitest";

import type { UpdaterState } from "@/types/ogb";
import { appSubLine } from "./SettingsNav";

const NOW = Date.parse("2026-11-21T12:00:00Z");
const HOUR = 60 * 60_000;
const line = (update: UpdaterState | null) => appSubLine(update, "0.1.184", NOW);

describe("the This app line in the Settings nav", () => {
  it("says Up to date only after a check in the last 24 hours found nothing newer", () => {
    expect(line({ status: "idle", upToDateAt: NOW - HOUR })).toBe("0.1.184 · Up to date");
    expect(line({ status: "idle", upToDateAt: NOW - 25 * HOUR })).toBe("0.1.184");
  });

  it("shows only the version when no check has finished, or the app has no state", () => {
    expect(line({ status: "idle" })).toBe("0.1.184");
    expect(line({ status: "checking" })).toBe("0.1.184");
    expect(line(null)).toBe("0.1.184");
  });

  it("shows only the version when a store updates the app", () => {
    expect(line({ status: "idle", managedByStore: true })).toBe("0.1.184");
    expect(line({ status: "idle", managedByStore: true, upToDateAt: NOW - HOUR })).toBe("0.1.184");
  });

  it("says an update is ready once it is downloaded", () => {
    expect(line({ status: "downloaded", version: "0.1.185", upToDateAt: NOW - HOUR })).toBe("0.1.184 · Update ready");
  });
});
