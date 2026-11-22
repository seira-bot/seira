import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { JOB_FENCE_EXE, TEST_EATER_EXE } from "./prepare-job-fence.mjs";

const root = join(import.meta.dirname, "..");
const read = (file) => readFileSync(join(root, file), "utf8");

describe("the Windows memory helper in the package", () => {
  it("builds before electron-builder packs the Windows app", () => {
    const scripts = JSON.parse(read("package.json")).scripts;
    expect(scripts["build:job-fence"]).toBe("node scripts/prepare-job-fence.mjs");
    const steps = scripts["package:win"].split(" && ");
    expect(steps.indexOf("pnpm build:job-fence")).toBeGreaterThan(-1);
    expect(steps.indexOf("pnpm build:job-fence")).toBeLessThan(steps.findIndex((step) => step.startsWith("electron-builder")));
  });

  it("ships the helper and never the test program", () => {
    const builder = read("electron-builder.yml");
    expect(builder).toContain("- from: dist-native/job-fence/win32-x64/seira-job-fence.exe\n      to: job-fence/seira-job-fence.exe");
    expect(builder).not.toContain("test-eater");
    expect(JOB_FENCE_EXE.split(/[\\/]/).slice(-4)).toEqual(["dist-native", "job-fence", "win32-x64", "seira-job-fence.exe"]);
    expect(TEST_EATER_EXE.split(/[\\/]/).slice(-3)).toEqual(["job-fence", "test", "test-eater.exe"]);
  });

  it("checks the packaged helper in the Windows package workflow", () => {
    const workflow = read(".github/workflows/package-windows.yml");
    expect(workflow).toContain('need "$res/job-fence/seira-job-fence.exe"');
    expect(workflow).toContain("$extracted/app/resources/job-fence/seira-job-fence.exe");
  });
});
