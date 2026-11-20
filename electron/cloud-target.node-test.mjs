import assert from "node:assert/strict";
import test from "node:test";
import { CLOUD_ORIGIN, STAGING_CLOUD_ORIGIN, checkoutDestination, cloudOrigin, cloudTarget, createCloudAccountClient } from "./cloud-account.mjs";
import { parseCloudOffer, parsePublicOffer } from "./cloud-home.mjs";

const filesOf = target => [target.file, target.saved, target.places, target.environments, target.sync, target.look];

test("with no setting the app signs in to Seira's Cloud", () => {
  assert.equal(cloudTarget({}).origin, CLOUD_ORIGIN);
  assert.equal(cloudTarget({}).kind, "seira");
});

test("Seira's Cloud is the default, and the environment still wins", () => {
  const seira = cloudTarget({});
  assert.equal(seira.origin, CLOUD_ORIGIN);
  assert.equal(seira.kind, "seira");
  assert.equal(seira.staging, false);
  assert.equal(cloudTarget({ SEIRA_CLOUD_STAGING: "1" }).origin, STAGING_CLOUD_ORIGIN);
  assert.equal(cloudTarget({ SEIRA_CLOUD_ORIGIN: CLOUD_ORIGIN }).origin, CLOUD_ORIGIN);
  assert.equal(cloudTarget({ SEIRA_CLOUD_ORIGIN: CLOUD_ORIGIN, SEIRA_CLOUD_STAGING: "1" }).origin, CLOUD_ORIGIN);
});

test("SEIRA_CLOUD_ORIGIN takes an https origin or http://127.0.0.1, and refuses anything else", () => {
  assert.equal(cloudTarget({ SEIRA_CLOUD_ORIGIN: "https://cloud.example.test" }).origin, "https://cloud.example.test");
  assert.equal(cloudTarget({ SEIRA_CLOUD_ORIGIN: "https://cloud.example.test:8443" }).origin, "https://cloud.example.test:8443");
  assert.equal(cloudTarget({ SEIRA_CLOUD_ORIGIN: "http://127.0.0.1:18899" }).origin, "http://127.0.0.1:18899");
  for (const value of ["http://cloud.example.test", "http://localhost:3000", "http://192.168.1.5", "ftp://cloud.example.test", "https://cloud.example.test/", "https://cloud.example.test/path",
    "https://user:pass@cloud.example.test", "https://cloud.example.test?x=1", "cloud.example.test", "", " https://cloud.example.test", "javascript:alert(1)", "file:///etc/passwd"]) {
    assert.deepEqual(cloudTarget({ SEIRA_CLOUD_ORIGIN: value }), cloudTarget({}), JSON.stringify(value));
  }
});

test("each Cloud keeps its own files, so one never reads or writes another's", () => {
  const targets = [cloudTarget({ SEIRA_CLOUD_STAGING: "1" }), cloudTarget({}), cloudTarget({ SEIRA_CLOUD_ORIGIN: "https://cloud.example.test" }),
    cloudTarget({ SEIRA_CLOUD_ORIGIN: "https://other.example.test" }), cloudTarget({ SEIRA_CLOUD_ORIGIN: "http://127.0.0.1:18899" })];
  const names = targets.flatMap(filesOf);
  assert.equal(new Set(names).size, names.length, "no file name is shared between two Clouds");
  assert.deepEqual(filesOf(cloudTarget({})), ["cloud-account-seira.bin", "cloud-accounts-seira.bin", "account-places-seira.json", "environments-seira.json", "cloud-sync-seira", "cloud-home-look-seira.json"]);
  assert.deepEqual(cloudTarget({ SEIRA_CLOUD_ORIGIN: "https://cloud.example.test" }), cloudTarget({ SEIRA_CLOUD_ORIGIN: "https://cloud.example.test" }), "the same origin keeps the same files");
});

test("an origin the environment chose is trusted by the client only when main says so", () => {
  const origin = "https://cloud.example.test";
  assert.throws(() => cloudOrigin(origin), /Invalid Seira Cloud address/);
  assert.equal(cloudOrigin(origin, false, true), origin);
  assert.throws(() => cloudOrigin("http://cloud.example.test", false, true), /Invalid Seira Cloud address/);
  assert.equal(cloudOrigin(CLOUD_ORIGIN), CLOUD_ORIGIN);
});

test("Seira's Cloud sells on its own page and nowhere else", () => {
  const own = CLOUD_ORIGIN, page = `${own}/bayar/${"a".repeat(43)}`;
  assert.equal(checkoutDestination(page, { own }), page);
  for (const value of [`${own}/bayar/`, `${own}/akun`, `${page}?x=1`, `${page}#x`, `http://cloud.seira.bot/bayar/${"a".repeat(43)}`, `https://evil.example.test/bayar/${"a".repeat(43)}`,
    `https://cloud.seira.bot.evil.test/bayar/${"a".repeat(43)}`, "https://checkout.dodopayments.com/session/cks_1", `https://u:p@cloud.seira.bot/bayar/${"a".repeat(43)}`]) {
    assert.equal(checkoutDestination(value, { own }), null, value);
  }
  assert.equal(checkoutDestination(page), null, "upstream never opens Seira's page");
});

const answer = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const identity = { expiresAt: Date.now() + 86400_000, device: { id: "device-1" }, account: { id: "account-1", email: "tester@example.test" } };
const token = `omc_${"S".repeat(43)}`;

async function seiraClient({ version = 1, checkoutUrl = `${CLOUD_ORIGIN}/bayar/${"b".repeat(43)}` } = {}) {
  const requests = [], browsers = []; let saved = null;
  const fetch = async (url) => {
    requests.push(url);
    const path = new URL(url).pathname;
    if (path === "/api/cloud/app/sign-in/start") return answer(200, { cloudContractVersion: version, attempt: "b".repeat(43), expiresIn: 600, resendAfter: 30 });
    if (path === "/api/cloud/app/sign-in/verify") return answer(200, { ...identity, cloudContractVersion: version, accessToken: token });
    if (path === "/api/cloud/desktop/session") return answer(200, { ...identity, cloudContractVersion: version, entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 0 } });
    if (path === "/api/cloud/desktop/checkout") return answer(200, { cloudContractVersion: version, url: checkoutUrl });
    return answer(404, { error: "not_found" });
  };
  const client = createCloudAccountClient({ origin: CLOUD_ORIGIN, fetch, deviceName: "Test", platform: "linux", appVersion: "0.1.113",
    store: { read: async () => saved, write: async value => { saved = value; } }, openBrowser: async url => { browsers.push(url); }, setTimer: () => 1, clearTimer: () => {} });
  return { client, requests, browsers, saved: () => saved };
}

test("a client on Seira's Cloud talks only to it, keeps its sign-in tied to it, and opens only its payment page", async () => {
  const { client, requests, browsers, saved } = await seiraClient();
  try {
    await client.start();
    assert.equal((await client.emailStart("tester@example.test")).outcome, "sent");
    assert.equal((await client.emailVerify("12345678")).outcome, "signed-in");
    assert.equal(saved().origin, CLOUD_ORIGIN);
    assert.equal((await client.checkout("pro", "app_menu")).outcome, "opened");
    assert.deepEqual(browsers, [`${CLOUD_ORIGIN}/bayar/${"b".repeat(43)}`]);
    assert.ok(requests.every(url => url.startsWith(`${CLOUD_ORIGIN}/`)));
  } finally { client.close(); }
  const dodo = await seiraClient({ checkoutUrl: "https://checkout.dodopayments.com/session/cks_1" });
  try {
    await dodo.client.start(); await dodo.client.emailStart("tester@example.test"); await dodo.client.emailVerify("12345678");
    assert.equal((await dodo.client.checkout("pro", "app_menu")).outcome, "failed");
    assert.equal(dodo.browsers.length, 0);
  } finally { dodo.client.close(); }
});

test("an unknown contract version is refused as unreachable, a known one is not", async () => {
  const { client } = await seiraClient({ version: 2 });
  try {
    await client.start();
    assert.equal((await client.emailStart("tester@example.test")).outcome, "failed");
  } finally { client.close(); }
});

const plan = (price, extra = {}) => ({ tier: "team", label: "Team", price: { currency: "IDR", interval: "month", ...price }, ...extra });

test("IDR plans parse in whole rupiah, and USD plans in cents keep working", () => {
  const idr = parseCloudOffer({ plans: [plan({ amount: 213000, extraSeatAmount: 30000 })] });
  assert.deepEqual(idr.plans, [{ tier: "team", label: "Team", amount: 213000, currency: "IDR", extraSeatAmount: 30000 }]);
  const usd = parseCloudOffer({ plans: [{ tier: "pro", price: { currency: "USD", interval: "month", amount: 4900 } }] });
  assert.deepEqual(usd.plans, [{ tier: "pro", amount: 4900 }], "USD has no currency field, as before");
  assert.equal(parsePublicOffer({ plans: [plan({ amount: 99000 })] }).plans[0].currency, "IDR");
});

test("an IDR plan with a bad amount, currency, interval or seat price is not sold", () => {
  const bad = [{ amount: 0 }, { amount: -1 }, { amount: 1.5 }, { amount: 100_000_001 }, { amount: "213000" }, { amount: 213000, interval: "year" }, { amount: 213000, currency: "EUR" }, { amount: 213000, currency: "idr" }];
  for (const price of bad) assert.equal(parseCloudOffer({ plans: [plan(price)] }), null, JSON.stringify(price));
  assert.equal(parseCloudOffer({ plans: [{ tier: "pro", price: { currency: "USD", interval: "month", amount: 10_000_001 } }] }), null, "the USD cap is unchanged");
  assert.equal(parseCloudOffer({ plans: [plan({ amount: 213000, extraSeatAmount: 100_000_001 })] }).plans[0].extraSeatAmount, undefined);
  assert.equal(parseCloudOffer({ plans: [plan({ amount: 213000, extraSeatAmount: -5 })] }).plans[0].extraSeatAmount, undefined);
  assert.equal(parseCloudOffer({ plans: [plan({ amount: 213000, extraSeatAmount: 0 })] }).plans[0].extraSeatAmount, 0);
  const notTeam = parseCloudOffer({ plans: [{ ...plan({ amount: 213000, extraSeatAmount: 30000 }), tier: "pro" }] });
  assert.equal(notTeam.plans[0].extraSeatAmount, undefined, "only a Team plan has a seat price");
});
