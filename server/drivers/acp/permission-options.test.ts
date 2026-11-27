import { describe, expect, it } from "vitest";

import { permissionOptions } from "./permission-options.ts";

const offered = [
  { optionId: "once", kind: "allow_once" },
  { optionId: "always", kind: "allow_always" },
  { optionId: "no", kind: "reject_once" },
  { optionId: "never", kind: "reject_always" },
];

describe("permissionOptions", () => {
  it("allows with the narrowest option, even when a wider one is offered", () => {
    expect(permissionOptions(offered, false).optionFor("allow")).toBe("once");
    expect(permissionOptions(offered, true).optionFor("allow")).toBe("once");
  });

  it("offers a session grant only when the agent ends it with its own session", () => {
    expect(permissionOptions(offered, false).optionAlways).toBeNull();
    expect(permissionOptions(offered, true).optionAlways).toBe("always");
  });

  it("refuses to allow with an option that is wider than the request or unknown", () => {
    const wide = [{ optionId: "always", kind: "allow_always" }, { optionId: "x", kind: "allow_custom" }, { optionId: "no", kind: "reject_once" }];
    expect(permissionOptions(wide, false).optionFor("allow")).toBeNull();
    expect(permissionOptions(wide, true).optionFor("allow")).toBeNull();
  });

  it("rejects with the narrowest reject option, then any reject option", () => {
    expect(permissionOptions(offered, false).optionFor("reject")).toBe("no");
    expect(permissionOptions([{ optionId: "never", kind: "reject_always" }], false).optionFor("reject")).toBe("never");
    expect(permissionOptions([{ optionId: "once", kind: "allow_once" }], false).optionFor("reject")).toBeNull();
  });

  it("skips an option with no id", () => {
    expect(permissionOptions([{ kind: "allow_once" }], false).optionFor("allow")).toBeNull();
  });
});
