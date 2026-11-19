import { describe, expect, it } from "vitest";
import { heavyReason, isLightPath, sourceNames } from "./ci-heavy.mjs";

const never = () => false;
const always = () => true;

describe("isLightPath", () => {
  it.each(["README.md", "docs/ci.md", "docs/screenshots/a/b.png", "brand/logo/x.webp"])("accepts %s", (file) => {
    expect(isLightPath(file)).toBe(true);
  });
  it.each([
    "package.json", "src/App.tsx", "brand/mascot/cast/cast.json", "brand/mascot/runtime/bot.js", "brand/logo/x.svg",
    "apps/docs/content/docs/a.mdx", "docs/a.json", "server/notes.md", "docs/../src/a.md", "", "docs//a.md", "docs/a\u0000.md",
  ])("refuses %s", (file) => {
    expect(isLightPath(file)).toBe(false);
  });
});

describe("heavyReason", () => {
  it("lets a change of unnamed docs and pictures skip the heavy jobs", () => {
    expect(heavyReason(["README.md", "docs/new-page.md", "docs/screenshots/x/shot.png", "brand/logo/a.png"], never)).toBeNull();
  });
  it("runs the heavy jobs for any other file", () => {
    expect(heavyReason(["README.md", "src/a.ts"], never)).toContain("src/a.ts");
    expect(heavyReason(["docs/ci.md", "package.json"], never)).toContain("package.json");
  });
  it("runs the heavy jobs when a source file names the file", () => {
    const named = (text: string) => text === "team-cloud.md";
    expect(heavyReason(["docs/team-cloud.md"], named)).toContain("team-cloud.md");
  });
  it("runs the heavy jobs when a source file names the folder of a picture", () => {
    const named = (text: string) => text === "brand/logo";
    expect(heavyReason(["brand/logo/a.png"], named)).toContain("brand/logo");
    expect(heavyReason(["docs/pages/a.md"], named)).toBeNull();
  });
  it.each([[[]], [undefined], [null], ["README.md"]])("runs the heavy jobs when the change list is %j", (files) => {
    expect(heavyReason(files as never, never)).not.toBeNull();
  });
  it("runs the heavy jobs when the search cannot tell", () => {
    expect(heavyReason(["README.md"], always)).not.toBeNull();
  });
});

describe("sourceNames in this repository", () => {
  it("finds docs that tests read", () => {
    expect(sourceNames("team-cloud.md")).toBe(true);
    expect(sourceNames("releasing.md")).toBe(true);
  });
  it("finds nothing for a name no source file holds", () => {
    // Built from parts, so that this file does not hold the name.
    expect(sourceNames(["no-such", "page", "8c1f2d7a.md"].join("-"))).toBe(false);
  });
  it("answers true when git cannot run", () => {
    expect(sourceNames("a", "/nonexistent-folder-for-ci-heavy")).toBe(true);
  });
});
