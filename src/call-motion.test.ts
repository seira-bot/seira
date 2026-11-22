import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const block = (opening: string) => {
  const start = css.indexOf(opening);
  expect(start).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf("\n}", start) + 2);
};

describe("call motion", () => {
  it("moves the rings, the halo and the pill wave only as live loops", () => {
    expect(css).toMatch(/\.call-ring \{ animation: call-ring 2\.8s ease-out infinite; \}/);
    expect(css).toMatch(/\.call-halo \{ animation: call-halo 1\.6s ease-in-out infinite; \}/);
    expect(css).toMatch(/\.call-wave-bar \{ transform-origin: center; animation: call-wave 1s ease-in-out infinite; \}/);
  });

  it("stills all three under the system reduced-motion setting", () => {
    const media = block("@media (prefers-reduced-motion: reduce) {\n  .call-ring");
    expect(media).toContain(".call-ring { animation: none;");
    expect(media).toContain(".call-halo { animation: none;");
    expect(media).toContain(".call-wave-bar { animation: none;");
  });

  it("stills all three when the app's reduced-motion switch is on", () => {
    for (const name of ["call-ring", "call-halo", "call-wave-bar"]) {
      expect(block(`:root[data-reduced-motion="true"] .${name} {`)).toContain("animation: none !important;");
    }
  });
});
