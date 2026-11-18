import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { seiraCloudSells } from "./seira-cloud-sale.mjs";

const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");

test("Seira sells no Cloud plan yet", () => assert.equal(seiraCloudSells(), false));

test("every door that sells a Cloud asks the sale switch first", () => {
  assert.match(main, /function cloudSalesAllowed\(\) \{\s*return seiraCloudSells\(\) && cloudOffersAllowed\(\);/);
  assert.match(main, /\.\.\.\(cloudSalesAllowed\(\) \? \{ onAddCloud/);
  assert.match(main, /offersReady: cloudSalesReady/);
  assert.match(main, /choices: \(\) => \(\{ cloud: cloudSalesAllowed\(\)/);
  assert.match(main, /if \(!\(await cloudSalesReady\(\)\)\) throw/);
});
