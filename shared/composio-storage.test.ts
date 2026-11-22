import { describe, expect, it } from "vitest";

import { composioStorageHost } from "./composio-storage.ts";

describe("composioStorageHost", () => {
  it("accepts Composio's own storage and AWS S3 hosts", () => {
    for (const host of [
      "composio.dev", "storage.composio.dev", "S3.amazonaws.com", "s3.us-east-1.amazonaws.com", "s3-us-west-2.amazonaws.com",
      "bucket.s3.amazonaws.com", "my.bucket.s3.dualstack.us-east-1.amazonaws.com", "bucket.s3-accelerate.amazonaws.com",
    ]) expect(composioStorageHost(host), host).toBe(true);
  });

  it("refuses every other host", () => {
    for (const host of [
      "amazonaws.com", "s3.amazonaws.com.evil.test", "evil-s3.amazonaws.com", "evilcomposio.dev", "localhost", "127.0.0.1",
      ".s3.amazonaws.com", "s3-.amazonaws.com", "ec2.amazonaws.com", "bucket.sqs.amazonaws.com",
    ]) expect(composioStorageHost(host), host).toBe(false);
  });

  it("answers an attack string in under 100 ms", () => {
    for (const host of [`s3-${"--".repeat(50_000)}.amazonaws.com`, `s3${".s3".repeat(50_000)}.amazonaws.com`]) {
      const started = performance.now();
      expect(composioStorageHost(host)).toBe(false);
      expect(performance.now() - started).toBeLessThan(100);
    }
  });
});
