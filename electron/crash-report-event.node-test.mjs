import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { holdsCredential } from "../shared/redact.ts";

import {
  BREADCRUMB_MESSAGES, MAX_BREADCRUMBS, MAX_FRAMES, buildEnvelope, buildEvent, crashSignature, detectPackageType, filterMessage, normalizeFile, parseFrames,
} from "./crash-report-event.mjs";

const ROOTS = ["/opt/Seira/resources/app.asar", "/opt/Seira/resources"];
const PEOPLE = { username: "canaryuser", hostname: "canary-host" };
const context = (extra = {}) => ({
  eventId: "a".repeat(32), timestamp: 1_700_000_000.5, appVersion: "1.2.3", environment: "test", packageType: "appimage", session: "b".repeat(32),
  platform: "linux", osVersion: "6.8.0-45-generic", electronVersion: "43.0.0", roots: ROOTS, breadcrumbs: [], ...PEOPLE, ...extra,
});
const mainError = (extra = {}) => ({ kind: "main-error", process: "main", errorName: "TypeError", message: "x is not a function", stack: "", ...extra });

test("AC-41: the message filter keeps a short plain message and refuses every shape that can carry a person's data", () => {
  assert.equal(filterMessage("x is not a function", PEOPLE), "x is not a function");
  const refused = [
    "ENOENT open /home/someone/notes.txt", "failed C:\\Users\\someone\\a", "see https://example.test", "mail someone@example.test", "code 1234567",
    "call api.example failed", "cannot find 'my private note'", 'bad "value"', "bad `value`", "hello canaryuser", "host CANARY-HOST down", "a".repeat(201), "", "line\nbreak", "tab\there",
  ];
  for (const message of refused) assert.equal(filterMessage(message, PEOPLE), null, JSON.stringify(message));
  assert.equal(filterMessage(42, PEOPLE), null);
  assert.equal(filterMessage("a".repeat(200), PEOPLE), "a".repeat(200));
  assert.equal(filterMessage("short five 12345", PEOPLE), "short five 12345");
});

const A = "aB3dE5gH7jK9mN1pQ3sT5v";
const n = (length) => A.repeat(Math.ceil(length / A.length)).slice(0, length);
const SECRET_SAMPLES = [
  `omd_${n(43)}`, `sk-proj-${A}`, `sk_live_${A}`, `xai-${A}`, `gsk_${A}${A}`, `csk-${A}${A}`, `LLM|123456|${A}`, `hf_${A}${A}`,
  `pypi-AgE${A}${A}${A}${A}`, `ghp_${A}`, `github_pat_${A}`, `glpat-${A}`, `xoxb-${A}`, `xapp-1-${A}`, "AKIAABCDEFGHIJKLMNOP", `AIza${A}${A}`,
  `npm_${A}`, `ntn_${n(46)}`, `pplx-${n(48)}`, `whsec_${A}`, `SG.${n(22)}.${n(43)}`, `bak_${A}`, `eyJhbGciOiJIUzI1NiJ9.${A}.${A}`,
];

test("NFR-054: the message filter refuses a message that holds a secret-shaped token", () => {
  for (const secret of SECRET_SAMPLES) {
    assert.equal(holdsCredential(secret), true, `redact.ts no longer matches ${secret}`);
    for (const message of [secret, `bad key ${secret}`, `key ${secret} bad`]) assert.equal(filterMessage(message, PEOPLE), null, message);
  }
  for (const message of ["AKIAABCDEFGHIJKLMNOP", "ASIAABCDEFGHIJKLMNOP", "eyJhbGciOiJIUzI1NiJ9", "sk-short", "key sk-x", "token ghp_short"]) {
    assert.equal(filterMessage(message, PEOPLE), null, message);
  }
  assert.equal(filterMessage("abcdefghij1234567890x", PEOPLE), null);
  assert.equal(filterMessage("a-b_c-d_e-f_g-h_i-j_k1", PEOPLE), null);
});

test("NFR-054: the secret prefix list tracks shared/redact.ts", () => {
  const source = readFileSync(new URL("../shared/redact.ts", import.meta.url), "utf8");
  const block = /const KEY_PREFIXES: RegExp\[\] = \[([\s\S]*?)\n\];/.exec(source)[1];
  assert.equal(block.split("\n").filter((line) => line.trim().startsWith("/")).length, SECRET_SAMPLES.length);
});

test("NFR-054: plain engine messages still pass", () => {
  for (const message of [
    "x is not a function", "Maximum call stack size exceeded", "requireActiveInternalCapability is not a function", "Invalid array length",
    "Cannot read properties of undefined", "task-runner is not defined", "a".repeat(200),
  ]) assert.equal(filterMessage(message, PEOPLE), message);
});

test("file names are normalized to a fixed prefix, or become <external>", () => {
  const cases = [
    ["http://127.0.0.1:8799/assets/index-abc.js", "app:///ui/assets/index-abc.js"],
    ["https://host.example:443/assets/a.js?x=1#y", "app:///ui/assets/a.js"],
    ["file:///opt/Seira/resources/app.asar/electron/main.mjs", "app:///electron/main.mjs"],
    ["/opt/Seira/resources/app.asar/electron/main.mjs", "app:///electron/main.mjs"],
    ["/opt/Seira/resources/server/index.js", "app:///server/index.js"],
    ["/opt/Seira/resources/app.asar.unpacked/server/a.js", "app:///server/a.js"],
    ["node:internal/process/task_queues", "node:internal/process/task_queues"],
    ["app:///server/index.js", "app:///server/index.js"],
    ["http://127.0.0.1:1/canary/room.js", "<external>"],
    ["http://127.0.0.1:1/assets/../x.js", "<external>"],
    ["/home/canaryuser/project/app.js", "<external>"],
    ["/opt/Seira/resources/other/x.js", "<external>"],
    ["/opt/Seira/resources/server/../../etc/passwd", "<external>"],
    ["/opt/Seira/resources/server/a b.js", "<external>"],
    ["/opt/Seira/resources/constructor/a.js", "<external>"],
    ["node:bad path", "<external>"],
    ["", "<external>"],
    [null, "<external>"],
    ["file:///home/%E0%A4%A", "<external>"],
  ];
  for (const [input, expected] of cases) assert.equal(normalizeFile(input, ROOTS), expected, String(input));
  assert.equal(normalizeFile("C:\\Seira\\resources\\app.asar\\electron\\main.mjs", ["C:\\Seira\\resources\\app.asar"]), "app:///electron/main.mjs");
  assert.equal(normalizeFile("file:///C:/Seira/resources/server/index.js", ["C:/Seira/resources"]), "app:///server/index.js");
});

test("frames: at most 30 newest first in the stack, oldest first in the event; foreign frames lose their function name", () => {
  const lines = ["TypeError: nope", "    at Object.<anonymous> (/opt/Seira/resources/app.asar/electron/main.mjs:10:5)",
    "    at async run (file:///opt/Seira/resources/server/index.js:3:4)",
    "    at secret/path.fn (/home/canaryuser/app.js:1:1)",
    "    at /home/canaryuser/other.js:7:8",
    "    at Foo.bar (node:internal/modules/run_main:1:2)",
    "    at weird @name (/opt/Seira/resources/server/x.js:1:1)"];
  const frames = parseFrames(lines.join("\n"), { roots: ROOTS, ...PEOPLE });
  assert.deepEqual(frames.map((frame) => frame.filename), ["app:///electron/main.mjs", "app:///server/index.js", "<external>", "<external>", "node:internal/modules/run_main", "app:///server/x.js"]);
  assert.deepEqual(frames.map((frame) => frame.function), ["Object.<anonymous>", "run", undefined, undefined, "Foo.bar", undefined]);
  assert.deepEqual(frames.map((frame) => frame.in_app), [true, true, false, false, false, true]);
  const long = Array.from({ length: 80 }, (_, index) => `    at f${index} (/opt/Seira/resources/server/a.js:${index + 1}:1)`).join("\n");
  assert.equal(parseFrames(long, { roots: ROOTS }).length, MAX_FRAMES);
  const built = buildEvent(mainError({ stack: long }), context()).event.exception.values[0].stacktrace.frames;
  assert.equal(built.length, MAX_FRAMES);
  assert.equal(built.at(-1).function, "f0", "the newest frame is last, as the vendor expects");
  assert.deepEqual(parseFrames(42), []);
});

test("a function name that carries the user name or the host name is dropped", () => {
  const stack = "    at canaryuser.run (/opt/Seira/resources/server/a.js:1:1)\n    at CANARY-HOST_task (/opt/Seira/resources/server/a.js:2:1)";
  const frames = parseFrames(stack, { roots: ROOTS, ...PEOPLE });
  assert.deepEqual(frames.map((frame) => frame.function), [undefined, undefined]);
});

test("AC-27: the package type comes from fixed rules", () => {
  const base = { isPackaged: true, env: {} };
  assert.equal(detectPackageType({ isPackaged: false, env: {} }), "dev");
  assert.equal(detectPackageType({ ...base, platform: "win32", windowsStore: true }), "msix");
  assert.equal(detectPackageType({ ...base, platform: "win32" }), "nsis");
  assert.equal(detectPackageType({ ...base, platform: "darwin" }), "dmg");
  assert.equal(detectPackageType({ ...base, platform: "linux", env: { APPIMAGE: "/x" } }), "appimage");
  assert.equal(detectPackageType({ ...base, platform: "linux", env: { SNAP: "/snap/seira" } }), "snap");
  assert.equal(detectPackageType({ ...base, platform: "linux", env: { FLATPAK_ID: "bot.seira.app" } }), "flatpak");
  assert.equal(detectPackageType({ ...base, platform: "linux", marker: "deb\n" }), "deb");
  assert.equal(detectPackageType({ ...base, platform: "linux", marker: "pacman" }), "pacman");
  assert.equal(detectPackageType({ ...base, platform: "linux", marker: "rpm" }), "linux");
  assert.equal(detectPackageType({ ...base, platform: "linux" }), "linux");
});

test("AC-27: the event carries the app version, the package type, the platform and the OS version", () => {
  const { event } = buildEvent(mainError(), context());
  assert.equal(event.release, "seira@1.2.3");
  assert.equal(event.environment, "test");
  assert.equal(event.tags.package, "appimage");
  assert.deepEqual(event.contexts, { os: { name: "Linux", version: "6.8.0-45-generic" }, app: { app_version: "1.2.3" }, runtime: { name: "electron", version: "43.0.0" } });
  assert.equal(event.event_id, "a".repeat(32));
  assert.equal(buildEvent(mainError(), context({ platform: "win32" })).event.contexts.os.name, "Windows");
  assert.equal(buildEvent(mainError(), context({ platform: "darwin", osVersion: "14.2.1" })).event.contexts.os.name, "macOS");
  assert.equal(buildEvent(mainError(), context({ osVersion: "bad version/with slash" })).event.contexts.os.version, "unknown");
});

test("AC-41/AC-42: the event has no user, server_name, request, device or extra, and the session id is the only id", () => {
  const { event } = buildEvent(mainError(), context());
  for (const key of ["user", "server_name", "request", "device", "extra"]) assert.equal(key in event, false, key);
  assert.equal("device" in event.contexts, false);
  assert.deepEqual(Object.keys(event.tags).sort(), ["kind", "package", "process", "session"]);
  assert.equal(event.tags.session, "b".repeat(32));
});

test("the error type comes from an allowlist and the error code only when it has the code shape", () => {
  assert.equal(buildEvent(mainError({ errorName: "RangeError" }), context()).event.exception.values[0].type, "RangeError");
  assert.equal(buildEvent(mainError({ errorName: "CanaryError" }), context()).event.exception.values[0].type, "Error");
  assert.equal(buildEvent(mainError({ errorCode: "ECONNRESET" }), context()).event.tags.error_code, "ECONNRESET");
  for (const bad of ["econnreset", "E", "ECONN RESET", "E".repeat(50), "/etc/passwd"]) {
    assert.equal("error_code" in buildEvent(mainError({ errorCode: bad }), context()).event.tags, false, bad);
  }
});

test("a server frame in app:/// form keeps its file, function and debug id", () => {
  const id = "123e4567-e89b-12d3-a456-426614174000";
  const { event } = buildEvent({ kind: "server-turn", process: "server", errorName: "TypeError", message: "x is not a function",
    stack: "    at run (app:///server/index.js:5:7)\n    at <external>:1:1", debugIds: { "app:///server/index.js": id } }, context());
  const frames = event.exception.values[0].stacktrace.frames;
  assert.deepEqual(frames.at(-1), { filename: "app:///server/index.js", lineno: 5, colno: 7, in_app: true, function: "run" });
  assert.deepEqual(event.debug_meta.images, [{ type: "sourcemap", code_file: "app:///server/index.js", debug_id: id }]);
});

test("an app:/// file whose part equals the user or computer name becomes <external>", () => {
  const { event } = buildEvent({ kind: "server-turn", process: "server", errorName: "TypeError", stack: "    at run (app:///server/canaryuser/x.js:5:7)" },
    context({ username: "canaryuser" }));
  assert.deepEqual(event.exception.values[0].stacktrace.frames, [{ filename: "<external>", lineno: 5, colno: 7, in_app: false }]);
  const host = buildEvent({ kind: "server-turn", process: "server", errorName: "TypeError", stack: "    at run (app:///server/canary-host.js:5:7)" },
    context({ hostname: "CANARY-HOST" })).event;
  assert.equal(host.exception.values[0].stacktrace.frames[0].filename, "<external>");
});

test("AC-41: the message becomes the value only when it passes the filter", () => {
  assert.equal(buildEvent(mainError({ message: "x is not a function" }), context()).event.exception.values[0].value, "x is not a function");
  assert.equal("value" in buildEvent(mainError({ message: "cannot read /home/canaryuser/a" }), context()).event.exception.values[0], false);
});

test("a message is sent only for a built-in engine error type, never for Error, a custom name or a plain name in free text", () => {
  const value = (report) => buildEvent(report, context()).event.exception.values[0].value;
  assert.equal(value(mainError({ errorName: "Error", message: "Contact Budi Santoso failed" })), undefined);
  assert.equal(value(mainError({ errorName: "CanaryError", message: "x is not a function" })), undefined);
  assert.equal(value(mainError({ errorName: "TypeError", message: "x is not a function" })), "x is not a function");
  assert.equal(value(mainError({ errorName: "TypeError", message: "hello canaryuser" })), undefined);
  assert.equal(value(mainError({ errorName: "TypeError", message: "Contact Budi Santoso failed" })), undefined, "two capitalized words read as a name");
  assert.equal(value(mainError({ errorName: "RangeError", message: "Maximum call stack size exceeded" })), "Maximum call stack size exceeded");
  for (const errorName of ["TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError"]) {
    for (const kind of [["main-error", "main"], ["renderer-error", "renderer"], ["server-turn", "server"], ["server-exit", "server"]]) {
      assert.equal(value({ kind: kind[0], process: kind[1], errorName, message: "bad input", stack: "" }), "bad input", `${errorName} ${kind[0]}`);
    }
  }
  for (const kind of [["main-error", "main"], ["renderer-error", "renderer"], ["server-turn", "server"], ["server-exit", "server"]]) {
    assert.equal(value({ kind: kind[0], process: kind[1], errorName: "Error", message: "bad input", stack: "" }), undefined, kind[0]);
  }
  assert.equal(value({ kind: "native", process: "gpu", reason: "crashed", message: "bad input" }), undefined);
  assert.equal(value({ kind: "hang", process: "renderer", message: "bad input" }), undefined);
});

test("native, hang and server exit reports carry no message and no value", () => {
  const native = buildEvent({ kind: "native", process: "gpu", reason: "crashed", exitCode: 139, message: "canary" }, context());
  assert.deepEqual(native.event.exception.values[0], { type: "Error" });
  assert.equal(native.signature, "native:gpu:crashed");
  assert.deepEqual([native.event.tags.reason, native.event.tags.exit_code, native.event.level, native.event.fingerprint], ["crashed", "139", "fatal", ["native:gpu:crashed"]]);
  const weird = buildEvent({ kind: "native", process: "renderer", reason: "canary reason", exitCode: "x" }, context());
  assert.equal(weird.signature, "native:renderer:unknown");
  assert.equal(weird.event.tags.exit_code, "unknown");
  const hang = buildEvent({ kind: "hang", process: "renderer", page: "settings" }, context());
  assert.equal(hang.signature, "hang:settings");
  assert.equal(hang.event.tags.page, "settings");
  assert.equal(hang.event.level, "error");
  assert.equal(buildEvent({ kind: "hang", process: "renderer", page: "canary-page" }, context()).signature, "hang:other");
  assert.equal(buildEvent({ kind: "hang", process: "renderer" }, context()).signature, "hang:other");
  const exit = buildEvent({ kind: "server-exit", process: "server", exitCode: 3 }, context());
  assert.equal(exit.signature, "server-exit:3");
  assert.deepEqual(exit.event.exception.values[0], { type: "Error" });
});

test("AC-47: the signature of a JS error is its type and its top three frames", () => {
  const stack = ["E", ...[1, 2, 3, 4].map((n) => `    at f${n} (/opt/Seira/resources/server/a.js:${n}:9)`)].join("\n");
  const one = buildEvent(mainError({ stack }), context());
  const two = buildEvent(mainError({ stack: stack.replace("f4", "other") }), context());
  assert.equal(one.signature, two.signature, "the fourth frame does not count");
  assert.notEqual(one.signature, buildEvent(mainError({ stack: stack.replace("f1", "other") }), context()).signature);
  assert.notEqual(one.signature, buildEvent(mainError({ stack, errorName: "RangeError" }), context()).signature);
  assert.equal(crashSignature({ kind: "main-error" }, [], "Error"), "main-error|Error");
});

test("server and page reports keep tags the allowlists accept", () => {
  assert.equal(buildEvent({ kind: "server-turn", process: "server", engine: "claude" }, context()).event.tags.engine, "claude");
  assert.equal(buildEvent({ kind: "server-turn", process: "server", engine: "My Bot/Name" }, context()).event.tags.engine, "custom");
  assert.equal(buildEvent({ kind: "renderer-error", process: "renderer", page: "chat" }, context()).event.tags.page, "chat");
  assert.equal(buildEvent({ kind: "renderer-error", process: "renderer", page: "/chat/room-1" }, context()).event.tags.page, "other");
  assert.equal(buildEvent({ kind: "nope", process: "main" }, context()), null);
  assert.equal(buildEvent({ kind: "main-error", process: "canary" }, context()), null);
  assert.equal(buildEvent(null, context()), null);
});

test("debug_meta lists only normalized files with a UUID debug id", () => {
  const stack = ["E", "    at a (http://127.0.0.1:1/assets/x.js:1:1)", "    at b (/opt/Seira/resources/server/y.js:1:1)", "    at c (/home/canaryuser/z.js:1:1)"].join("\n");
  const debugIds = {
    "http://127.0.0.1:1/assets/x.js": "0123abcd-0123-4abc-8def-0123456789AB",
    "/opt/Seira/resources/server/y.js": "not-a-uuid",
    "/home/canaryuser/z.js": "0123abcd-0123-4abc-8def-0123456789ab",
    "/opt/Seira/resources/server/unused.js": "0123abcd-0123-4abc-8def-0123456789ab",
  };
  const { event } = buildEvent({ kind: "renderer-error", process: "renderer", stack, debugIds }, context());
  assert.deepEqual(event.debug_meta, { images: [{ type: "sourcemap", code_file: "app:///ui/assets/x.js", debug_id: "0123abcd-0123-4abc-8def-0123456789ab" }] });
  assert.equal("debug_meta" in buildEvent(mainError({ stack }), context()).event, false);
});

test("AC-45: breadcrumbs keep only the three categories with fixed messages, at most 20", () => {
  const crumb = (category, message, timestamp = 1) => ({ category, message, timestamp });
  const attempts = [crumb("app.start", "app started"), crumb("page", "page chat"), crumb("process", "renderer gone"),
    crumb("console", "log text canary"), crumb("http", "GET /canary"), crumb("page", "page /canary/room"), crumb("process", "canary"),
    crumb("constructor", "x"), crumb("page", "page settings", Number.NaN), null, "string"];
  const { event } = buildEvent(mainError(), context({ breadcrumbs: attempts }));
  assert.deepEqual(event.breadcrumbs.map((item) => item.message), ["app started", "page chat", "renderer gone"]);
  const many = Array.from({ length: 50 }, (_, index) => crumb("page", "page chat", index + 1));
  assert.equal(buildEvent(mainError(), context({ breadcrumbs: many })).event.breadcrumbs.length, MAX_BREADCRUMBS);
  assert.deepEqual(Object.keys(BREADCRUMB_MESSAGES), ["app.start", "page", "process"]);
});

test("AC-46: the envelope holds one event item, no attachment, and no dsn", () => {
  const { event } = buildEvent(mainError(), context());
  const envelope = buildEnvelope(event, "2026-11-22T00:00:00.000Z");
  const lines = envelope.split("\n");
  assert.equal(lines.length, 4);
  assert.equal(lines[3], "");
  const header = JSON.parse(lines[0]), item = JSON.parse(lines[1]);
  assert.deepEqual(header, { event_id: event.event_id, sent_at: "2026-11-22T00:00:00.000Z" });
  assert.deepEqual(item, { type: "event", length: Buffer.byteLength(lines[2]) });
  assert.deepEqual(JSON.parse(lines[2]), event);
  assert.doesNotMatch(envelope, /attachment|minidump|dsn/);
});

test("AC-41: a canary in every field a person or a crash can control does not reach the envelope", () => {
  const stack = [
    "Error: canary-message",
    "    at canary/frame.fn (/home/canaryuser/canary-project/canary-file.js:1:1)",
    "    at CANARY@fn (/opt/Seira/resources/app.asar/electron/main.mjs:5:5)",
    "    at canaryuser.run (http://canary-host.example:99/canary/path.js?canary=1:2:2)",
  ].join("\n");
  const messages = ["fail /home/canaryuser/canary-doc", "canary@example.test", "canary-host.example went down", "user canaryuser failed", "bad 'canary prompt text'", "id 99999999"];
  for (const message of messages) {
    const { event } = buildEvent({ kind: "renderer-error", process: "renderer", errorName: "CanaryError", errorCode: "canary", message, stack, page: "canary-page",
      engine: "canary engine", debugIds: { "/home/canaryuser/x.js": "canary" } }, context({ breadcrumbs: [{ category: "page", message: "page /canary", timestamp: 1 }, { category: "canary", message: "canary", timestamp: 1 }] }));
    const text = buildEnvelope(event, "2026-11-22T00:00:00.000Z");
    assert.doesNotMatch(text, /canary/i, message);
  }
});
