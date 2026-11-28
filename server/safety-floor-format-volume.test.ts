import { describe, expect, it } from "vitest";
import { floorVerdict } from "./safety-floor.ts";

describe("the Windows-mode never-list blocks Format-Volume and Clear-Disk", () => {
  it.each([
    "Format-Volume -DriveLetter C -FileSystem NTFS -Confirm:$false",
    "Storage\\Format-Volume -DriveLetter D",
    "Get-Partition -DiskNumber 1 | Format-Volume -FileSystem exFAT",
  ])("blocks %s", (line) => {
    expect(floorVerdict(line, "win32")?.rule).toBe("format-disk");
  });

  it.each([
    "Clear-Disk -Number 0 -RemoveData -Confirm:$false",
    "Clear-Disk -Number 0 -removedata",
    "Clear-Disk -Number 0 -RemoveD",
    "Clear-Disk -Number 0 -RemoveData:$true",
    "Clear-Disk -Number 0 –RemoveData",
    "Get-Disk 1 | Clear-Disk -RemoveData -RemoveOEM",
    "Clear-Disk -Number 0 -Confirm:$false",
    "Clear-Disk -Number 0 -RemoveOEM",
  ])("blocks %s", (line) => {
    expect(floorVerdict(line, "win32")?.rule).toBe("format-disk");
  });

  it.each([
    "Get-Volume",
  ])("still allows %s", (line) => {
    expect(floorVerdict(line, "win32")).toBeNull();
  });
});
