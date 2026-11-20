import { describe, expect, it } from "vitest";

import { compileJsxPage } from "./jsx-compile.ts";

describe("compileJsxPage", () => {
  it("accepts a saved page that imports the shell's module by its old name", () => {
    expect(compileJsxPage('import { Chart } from "mausbot";\nexport default function Page() { return <Chart />; }').ok).toBe(true);
    expect(compileJsxPage('import { Chart } from "seira";\nexport default function Page() { return <Chart />; }').ok).toBe(true);
    expect(compileJsxPage('import x from "lodash";\nexport default x;').ok).toBe(false);
  });
});
