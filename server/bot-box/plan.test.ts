import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { engineInstallRoots } from "../engine-roots.ts";
import { BOX_MUTATIONS, CPU_LIST_FILES, argvPaths, bwrapArgs, planBox, signInPrograms, taskWorkspaceIds, under, visibleInBox, type BoxAudience, type BoxMutation, type BoxRequest, type BoxSetup } from "./plan.ts";

const home = "/data";
const dataDir = "/data/.seira";
const setup = (mutate?: BoxMutation[]): BoxSetup => ({
  dataDir, home, codeRoots: ["/app"], engineRoots: engineInstallRoots(dataDir), seccompFd: 3,
  bridges: [{ name: "egress", port: 3128, socket: `${dataDir}/box/egress.sock` }, { name: "harness", port: 8799, socket: `${dataDir}/box/harness.sock` }],
  mutate: mutate ? new Set(mutate) : undefined,
});
const cwd = join(dataDir, "task-workspaces", "bot-a", "thread-1");
const turn = (mutate?: BoxMutation[]) => planBox(setup(mutate), {
  command: "/usr/local/bin/claude", args: ["-p", "--additional-mcp-config", "@/tmp/seira-copilot-mcp-x/config.json", "--append-system-prompt-file=/tmp/seira-system-y/prompt.txt"],
  cwd, env: { PATH: "/usr/bin", HOME: home, CLAUDE_CONFIG_DIR: "/data/.claude" }, rw: [join(dataDir, "perm-abc.sock")],
});

// The box runs only on a Linux Cloud home (detect.ts says "not-linux" anywhere else): its plan is bubblewrap's argv
// over POSIX paths, which Windows' path module would write with drive letters and backslashes.
const linuxBox = describe.skipIf(process.platform === "win32");

describe("explicit read-only grants", () => {
  it("overrides a writable engine profile for its staged skills", () => {
    const home = join(process.cwd(), "box-fixture-home");
    const dataDir = join(home, "data");
    const profile = join(dataDir, "providers", "antigravity", "account");
    const skills = join(profile, "seira-skills");
    const plan = planBox({ dataDir, home, codeRoots: [], engineRoots: [], bridges: [] }, {
      command: "antigravity", args: [], cwd: join(dataDir, "task-workspaces", "bot", "thread"),
      env: { HOME: home, GEMINI_HOME: profile }, ro: [skills],
    });
    expect(visibleInBox(plan, join(skills, "hash", "SKILL.md"))).toBe("ro");
    expect(visibleInBox(plan, join(profile, "antigravity-acp", "acp_token.json"))).toBe("rw");
    const args = bwrapArgs(plan);
    expect(args).toContain("--ro-bind-try");
    expect(args.slice(args.indexOf(skills) - 1, args.indexOf(skills) + 2)).toEqual(["--ro-bind-try", skills, skills]);
  });
});

linuxBox("the box plan", () => {
  it("shows the turn its own folders and the code, and nothing else of the data folder", () => {
    const plan = turn();
    expect(plan.botId).toBe("bot-a");
    expect(visibleInBox(plan, cwd)).toBe("rw");
    expect(visibleInBox(plan, join(dataDir, "bots", "bot-a", "SOUL.md")), "its own standing instructions, never writable").toBe("ro");
    expect(visibleInBox(plan, join(dataDir, "workspaces", "bot-a", "MEMORY.md"))).toBe("rw");
    expect(visibleInBox(plan, join(dataDir, "perm-abc.sock"))).toBe("rw");
    expect(visibleInBox(plan, "/data/.claude/settings.json")).toBe("rw");
    expect(visibleInBox(plan, "/tmp/seira-copilot-mcp-x/config.json")).toBe("ro");
    expect(visibleInBox(plan, "/tmp/seira-system-y/prompt.txt")).toBe("ro");
    expect(visibleInBox(plan, "/app/dist-server/index.js")).toBe("ro");
    expect(visibleInBox(plan, "/usr/local/bin/claude")).toBe("ro");
    for (const hidden of ["messages.db", "config.json", "logins.json", "providers/x", "tools/y", "box/egress.sock",
      "workspaces/bot-b/MEMORY.md", "task-workspaces/bot-b/thread-9/notes.md", "task-workspaces/bot-a/thread-2/notes.md",
      "bots/bot-b/SOUL.md", "bots/bot-a/other.json"]) {
      expect(visibleInBox(plan, join(dataDir, hidden)), hidden).toBe("none");
    }
    expect(visibleInBox(plan, "/tmp/other-turn/mcp.json")).toBe("none");
    expect(visibleInBox(plan, "/.fly/api")).toBe("none");
    expect(visibleInBox(plan, "/root/.ssh/id_ed25519")).toBe("none");
  });

  it("a process the bot's conversations share sees all of that bot's conversation folders and uploads, and no other bot's", () => {
    const plan = planBox(setup(), { command: "opencode", args: ["acp"], cwd, env: { HOME: home }, botThreads: true });
    expect(plan.botId).toBe("bot-a");
    for (const own of ["task-workspaces/bot-a/thread-1/a.md", "task-workspaces/bot-a/thread-2/notes.md", "workspaces/bot-a/MEMORY.md"]) expect(visibleInBox(plan, join(dataDir, own)), own).toBe("rw");
    expect(visibleInBox(plan, join(dataDir, "box-uploads", "bot-a", "thread-2", "photo.png"))).toBe("ro");
    for (const hidden of ["task-workspaces/bot-b/thread-9/notes.md", "workspaces/bot-b/MEMORY.md", "box-uploads/bot-b/thread-9/x.png", "messages.db"]) {
      expect(visibleInBox(plan, join(dataDir, hidden)), hidden).toBe("none");
    }
    expect(visibleInBox(turn(), join(dataDir, "box-uploads", "bot-a", "thread-2", "photo.png")), "one conversation's box keeps only its own uploads").toBe("none");
  });

  it("writes the bubblewrap argv in mount order, with its own namespaces and the bridged sockets", () => {
    const args = bwrapArgs(turn());
    const text = args.join(" ");
    for (const flag of ["--unshare-user", "--unshare-pid", "--unshare-net", "--unshare-ipc", "--unshare-uts", "--die-with-parent", "--hostname seira-box", "--seccomp 3", `--chdir ${cwd}`]) expect(text).toContain(flag);
    expect(bwrapArgs(planBox({ ...setup(), seccompFd: undefined }, { command: "/usr/bin/x", args: [], env: {} })).join(" ")).not.toContain("--seccomp");
    expect(text).toContain("--ro-bind /usr /usr");
    expect(text).toContain("--symlink usr/bin /bin");
    expect(text).toContain("--proc /proc --dev /dev --tmpfs /tmp");
    // HOME, then the data folder emptied, then the turn's own folders put back: order is the protection.
    const order = [args.indexOf("--bind"), args.indexOf("--tmpfs", args.indexOf(home)), args.indexOf(cwd)];
    expect(args[order[0]! + 1]).toBe(home);
    expect(args[order[1]! + 1]).toBe(dataDir);
    expect(order[0]).toBeLessThan(order[1]!);
    expect(order[1]).toBeLessThan(order[2]!);
    expect(text).toContain(`--dir /run/seira --bind ${dataDir}/box/egress.sock /run/seira/egress.sock --bind ${dataDir}/box/harness.sock /run/seira/harness.sock`);
    expect(text).not.toContain("--new-session");
  });

  it("puts the engines Seira installed back whole and read-only, whatever else the turn may write", () => {
    // npm's bin entries are relative links into the prefix: `bin/opencode -> ../lib/node_modules/opencode-ai/bin/opencode.exe`.
    const prefix = join(dataDir, "tools", "npm");
    const engineFiles = [`${prefix}/bin/opencode`, `${prefix}/lib/node_modules/opencode-ai/bin/opencode.exe`, `${prefix}/bin/codex`,
      `${prefix}/lib/node_modules/@openai/codex/bin/codex.js`, join(dataDir, "tools", "antigravity-acp", "linux-x64", "versions", "abc", "agy_acp_server"),
      // An AI's own build the app installed without Node.js: the PATH entry and its version folder.
      join(dataDir, "tools", "standalone", "opencode", "bin", "opencode"), join(dataDir, "tools", "standalone", "opencode", "1.19.4", "opencode")];
    const asked = planBox(setup(), {
      command: `${prefix}/bin/opencode`, args: ["acp", `${prefix}/lib/node_modules/opencode-ai/package.json`], cwd,
      env: { HOME: home, XDG_CACHE_HOME: `${prefix}/cache`, OPENCODE_HOME: `${prefix}/lib` }, rw: [`${prefix}/bin`, join(dataDir, "tools")],
    });
    for (const plan of [turn(), turn(["bind-data"]), asked]) {
      for (const file of engineFiles) expect(visibleInBox(plan, file), file).toBe("ro");
    }
    for (const other of ["tools/chrome/131/linux/chrome", "tools/agent-browser/0.37/agent-browser", "tools/token"]) {
      expect(visibleInBox(turn(), join(dataDir, other)), other).toBe("none");
    }
    const args = bwrapArgs(turn());
    const engines = args.findIndex((arg, i) => arg === "--ro-bind-try" && args[i + 1] === prefix && args[i + 2] === prefix);
    expect(engines).toBeGreaterThan(args.findIndex((arg, i) => arg === "--tmpfs" && args[i + 1] === dataDir));
    const lastWritable = args.reduce((last, arg, i) => (arg === "--bind" || arg === "--bind-try") && !args[i + 2]!.startsWith("/run/seira/") ? i : last, -1);
    expect(engines).toBeGreaterThan(lastWritable);
  });

  it("the engines are there wherever HOME and the data folder are", () => {
    const own = join(dataDir, "engine-homes", "member-aaaaaaaaaaaaaaaa");
    const team = planBox(setup(), { command: "opencode", args: [], cwd, env: { HOME: own }, home: own });
    expect(visibleInBox(team, join(dataDir, "tools", "npm", "bin", "opencode"))).toBe("ro");
    const apart = planBox({ ...setup(), dataDir: "/srv/seira", home: "/home/seira", engineRoots: engineInstallRoots("/srv/seira") }, { command: "opencode", args: [], cwd: "/srv/seira/task-workspaces/b/t", env: {} });
    expect(visibleInBox(apart, "/srv/seira/tools/npm/bin/opencode")).toBe("ro");
    expect(visibleInBox(apart, "/srv/seira/messages.db")).toBe("none");
  });

  it("TMPDIR never puts the host's /tmp back; another temp folder is put back", () => {
    const plan = planBox(setup(), { command: "/usr/bin/x", args: [], cwd, env: { TMPDIR: "/tmp" } });
    expect(visibleInBox(plan, "/tmp/other-turn/mcp.json")).toBe("none");
    expect(visibleInBox(plan, "/tmp")).toBe("none");
    const elsewhere = planBox(setup(), { command: "/usr/bin/x", args: [], cwd, env: { TMPDIR: "/data/scratch" } });
    expect(visibleInBox(elsewhere, "/data/scratch/x")).toBe("rw");
  });

  it("a shared-network box (a browser) has no bridges and no network namespace", () => {
    const plan = planBox(setup(), { command: "/opt/chrome", args: [], env: {}, net: "shared", rw: ["/data/.seira/browser/profiles/p1"] });
    expect(plan.net).toBe("shared");
    expect(bwrapArgs(plan).join(" ")).not.toContain("--unshare-net");
    expect(bwrapArgs(plan).join(" ")).not.toContain("/run/seira");
    expect(visibleInBox(plan, "/data/.seira/browser/profiles/p1/Default")).toBe("rw");
    expect(visibleInBox(plan, "/data/.seira/messages.db")).toBe("none");
  });

  it("a relay socket goes in at /run/seira/relay.sock only for a box with its own network", () => {
    const relay = `${dataDir}/box/relay-ab12.sock`;
    const plan = planBox(setup(), { command: "/usr/bin/agy", args: [], cwd, env: { HOME: home }, relay });
    expect(bwrapArgs(plan).join(" ")).toContain(`--bind ${relay} /run/seira/relay.sock`);
    expect(visibleInBox(plan, "/run/seira/relay.sock")).toBe("rw");
    expect(visibleInBox(plan, relay)).toBe("none");
    expect(visibleInBox(plan, `${dataDir}/box/egress.sock`)).toBe("none");
    const shared = planBox(setup(), { command: "/opt/chrome", args: [], env: {}, net: "shared", relay });
    expect(bwrapArgs(shared).join(" ")).not.toContain(relay);
  });

  it("has the machine's CPU list read-only and nothing else of /sys, so a TCMalloc runtime (Antigravity) can start", () => {
    // Measured on a Fly Cloud home (2, 4 and 8 shared CPUs): without `possible` Google's runtime stops at start with
    // "tcmalloc/internal/sysinfo.h:76] CHECK in NumCPUs" and exit 134; with it, initialize answers.
    const command = join(dataDir, "tools", "antigravity-acp", "linux-x64", "versions", "abc", "agy_acp_server.par");
    for (const plan of [turn(), planBox(setup(), { command, args: ["--uid="], cwd, env: { HOME: home } })]) {
      expect(visibleInBox(plan, "/sys/devices/system/cpu/possible")).toBe("ro");
      expect(visibleInBox(plan, "/sys/devices/system/cpu/online")).toBe("ro");
      for (const hidden of ["/sys/devices/system/cpu/vulnerabilities/spectre_v2", "/sys/class/net/eth0/address", "/sys/fs/cgroup/memory.max", "/sys/kernel/mm"]) {
        expect(visibleInBox(plan, hidden), hidden).toBe("none");
      }
      const text = bwrapArgs(plan).join(" ");
      for (const file of CPU_LIST_FILES) expect(text).toContain(`--ro-bind-try ${file} ${file}`);
      expect(text).not.toMatch(/--(?:ro-)?bind(?:-try)? \/sys /);
    }
  });

  it("Antigravity's own profile (GEMINI_HOME) goes back read-write, and no other account's", () => {
    const profile = join(dataDir, "providers", "antigravity", "a".repeat(64));
    const plan = planBox(setup(), { command: join(dataDir, "tools", "antigravity-acp", "linux-x64", "versions", "abc", "agy_acp_server"), args: ["--uid="], cwd, env: { HOME: home, GEMINI_HOME: profile } });
    expect(visibleInBox(plan, join(profile, "antigravity-acp", "acp_token.json"))).toBe("rw");
    expect(visibleInBox(plan, join(dataDir, "providers", "antigravity", "b".repeat(64), "antigravity-acp", "acp_token.json"))).toBe("none");
    expect(visibleInBox(plan, join(dataDir, "providers", "key"))).toBe("none");
  });

  it("a cwd outside the data folder is the turn's folder; a bot named by the caller gets its own folder", () => {
    const plan = planBox(setup(), { command: "/usr/bin/codex", args: [], cwd: "/data/projects/site", env: { HOME: home }, botId: "bot-z" });
    expect(plan.botId).toBe("bot-z");
    expect(visibleInBox(plan, "/data/projects/site/index.html")).toBe("rw");
    expect(visibleInBox(plan, join(dataDir, "workspaces", "bot-z"))).toBe("rw");
    expect(visibleInBox(plan, join(dataDir, "workspaces", "bot-y"))).toBe("none");
  });

  it("on a Team Cloud the turn's HOME is its audience's engine home: the server's HOME and every other audience's home are not there", () => {
    const own = join(dataDir, "engine-homes", "member-aaaaaaaaaaaaaaaa"), other = join(dataDir, "engine-homes", "member-bbbbbbbbbbbbbbbb");
    const plan = planBox(setup(), {
      command: "/usr/local/bin/claude", args: [], cwd, env: { HOME: own, CLAUDE_CONFIG_DIR: `${own}/.claude-work`, CODEX_HOME: `${own}/.seira-folders/CODEX_HOME-abc` },
      home: own, shared: [{ source: "/data/.claude/.credentials.json", target: `${own}/.claude/.credentials.json` }, { source: "/data/x", target: "/elsewhere/x" }],
    });
    expect(visibleInBox(plan, `${own}/.claude/projects/p/s.jsonl`)).toBe("rw");
    expect(visibleInBox(plan, `${own}/.claude/.credentials.json`)).toBe("rw");
    for (const hidden of [`${other}/.claude/projects/p/s.jsonl`, "/data/.claude/projects/p/s.jsonl", "/data/.claude/.credentials.json", "/data/.codex/sessions/x.jsonl",
      "/data/notes.txt", join(dataDir, "engine-homes", ".held", "1", "x"), join(dataDir, "messages.db"), "/elsewhere/x"]) {
      expect(visibleInBox(plan, hidden), hidden).toBe("none");
    }
    expect(visibleInBox(plan, cwd)).toBe("rw");
    expect(visibleInBox(plan, join(dataDir, "workspaces", "bot-a", "MEMORY.md"))).toBe("rw");
    // The home goes back after the data folder is emptied, the team's sign-in over its name in the home after that.
    const args = bwrapArgs(plan);
    const at = (flag: string, target: string) => args.findIndex((arg, i) => arg === flag && args[i + (flag === "--tmpfs" ? 1 : 2)] === target);
    expect(args).not.toContain(home);
    expect(at("--tmpfs", dataDir)).toBeGreaterThan(-1);
    expect(at("--tmpfs", dataDir)).toBeLessThan(at("--bind", own));
    expect(at("--bind", own)).toBeLessThan(at("--bind-try", `${own}/.claude/.credentials.json`));
    expect(args.join(" ")).toContain(`--bind-try /data/.claude/.credentials.json ${own}/.claude/.credentials.json`);
    expect(args.filter((arg) => arg.startsWith(`${own}/.seira-folders`) || arg === `${own}/.claude-work`)).toEqual([]);
    // Without an engine home (a My Cloud, a desktop) the box has the server's HOME as before.
    expect(visibleInBox(turn(), "/data/.claude/projects/p/s.jsonl")).toBe("rw");
  });

  it("a data folder outside HOME is simply not there", () => {
    const plan = planBox({ ...setup(), dataDir: "/srv/seira", home: "/home/seira" }, { command: "/usr/bin/x", args: [], cwd: "/srv/seira/task-workspaces/b/t", env: {} });
    expect(visibleInBox(plan, "/srv/seira/messages.db")).toBe("none");
    expect(visibleInBox(plan, "/srv/seira/task-workspaces/b/t")).toBe("rw");
    expect(visibleInBox(plan, "/srv/seira/workspaces/b")).toBe("rw");
    expect(bwrapArgs(plan).join(" ")).not.toContain("--tmpfs /srv/seira");
  });

  it("shows no path on the command line that is in the data folder or holds it, unless the caller named it", () => {
    for (const { dataDir, home } of [{ dataDir: "/data/.seira", home: "/data" }, { dataDir: "/srv/seira", home: "/home/seira" }]) {
      const server = ["config.json", "sessions.json", "messages.db", "workspaces/other/MEMORY.md"].map((file) => join(dataDir, file));
      const ask = (args: string[], ro: string[] = []) => planBox({ ...setup(), dataDir, home }, { command: "/bin/sh", args, cwd: join(dataDir, "task-workspaces", "b", "t"), env: {}, botId: "b", ro });
      for (const args of [server, [dataDir], [`--model=${server[0]}`], [`@${server[0]}`], [join(dataDir, "..")], [join(dataDir, "workspaces", "..")], ["/srv", "/var"]]) {
        const plan = ask(args);
        for (const file of server) expect(visibleInBox(plan, file), `${dataDir}: ${args.join(" ")}`).toBe("none");
      }
      // A server whose program is in the bot's own folder still finds it: with the bot known its folder is there
      // anyway, and without one (a configured server run for a chat) the file itself is shown, read-only.
      expect(visibleInBox(ask([join(dataDir, "workspaces", "b", "tools", "server.js")]), join(dataDir, "workspaces", "b", "tools", "server.js"))).not.toBe("none");
      const noBot = planBox({ ...setup(), dataDir, home }, { command: "python3", args: [join(dataDir, "workspaces", "b", "tools", "server.py")], env: {}, configured: true });
      expect(visibleInBox(noBot, join(dataDir, "workspaces", "b", "tools", "server.py"))).toBe("ro");
      expect(visibleInBox(noBot, join(dataDir, "config.json"))).toBe("none");
      // Never another bot's for a box that has a bot, and never the folder of every bot.
      expect(visibleInBox(ask([join(dataDir, "workspaces", "other", "MEMORY.md")]), join(dataDir, "workspaces", "other", "MEMORY.md"))).toBe("none");
      for (const all of [join(dataDir, "workspaces"), join(dataDir, "task-workspaces")]) {
        expect(visibleInBox(planBox({ ...setup(), dataDir, home }, { command: "ls", args: [all], env: {}, configured: true }), join(all, "other", "MEMORY.md"))).toBe("none");
      }
      expect(visibleInBox(ask(["--token", join(dataDir, "hook-tokens", "t", "token")], [join(dataDir, "hook-tokens", "t")]), join(dataDir, "hook-tokens", "t", "token"))).toBe("ro");
      expect(visibleInBox(ask(["--mcp-config", "/tmp/seira-mcp-1/mcp.json"]), "/tmp/seira-mcp-1/mcp.json")).toBe("ro");
      expect(visibleInBox(ask([]), join(dataDir, "bots", "b", "SOUL.md"))).toBe("ro");
    }
  });

  it("makes nothing of the data folder writable for a configured server's environment, but the bot's own folders", () => {
    const dataDir = "/data/.seira";
    const ask = (env: Record<string, string>, configured: boolean) => planBox({ ...setup(), dataDir, home: "/data" }, { command: "sh", args: [], cwd: join(dataDir, "task-workspaces", "b", "t"), env, botId: "b", configured });
    for (const value of [join(dataDir, "config.json"), join(dataDir, "box"), dataDir, join(dataDir, "workspaces", "other"), "/"]) {
      for (const name of ["XDG_CACHE_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "TMPDIR"]) {
        const plan = ask({ [name]: value }, true);
        for (const file of ["config.json", "box/harness.sock", "messages.db", "workspaces/other/MEMORY.md"]) expect(visibleInBox(plan, join(dataDir, file)), `${name}=${value}`).toBe("none");
      }
    }
    expect(visibleInBox(ask({ XDG_CACHE_HOME: join(dataDir, "workspaces", "b", "cache") }, true), join(dataDir, "workspaces", "b", "cache", "x"))).toBe("rw");
    // An engine Seira starts keeps the home it was given there.
    expect(visibleInBox(ask({ CODEX_HOME: join(dataDir, "providers", "codex-1") }, false), join(dataDir, "providers", "codex-1", "auth.json"))).toBe("rw");
  });

  it("each mutation opens exactly the hole it names", () => {
    const base = turn();
    const flips: Record<BoxMutation, (plan: ReturnType<typeof turn>) => boolean> = {
      "bind-data": (plan) => visibleInBox(plan, join(dataDir, "messages.db")) === "rw",
      "bind-otherws": (plan) => visibleInBox(plan, join(dataDir, "workspaces", "bot-b", "MEMORY.md")) === "rw",
      "share-pid": (plan) => !plan.options.includes("--unshare-pid"),
      "share-net": (plan) => plan.net === "shared",
      "env-all": () => true,
      "tmp-shared": (plan) => visibleInBox(plan, "/tmp/other-turn/mcp.json") === "rw",
      "no-seccomp": (plan) => !plan.options.includes("--seccomp"),
      "engines-rw": (plan) => visibleInBox(plan, join(dataDir, "tools", "npm", "bin", "opencode")) === "rw",
    };
    for (const mutation of BOX_MUTATIONS) {
      if (mutation === "env-all") continue;
      expect(flips[mutation](base), `${mutation} without the mutation`).toBe(false);
      expect(flips[mutation](turn([mutation])), `${mutation} with the mutation`).toBe(true);
    }
    // One mutation never opens another's hole.
    expect(flips["bind-data"](turn(["share-pid"]))).toBe(false);
    expect(flips["share-pid"](turn(["bind-otherws"]))).toBe(false);
    expect(flips["tmp-shared"](turn(["bind-data"]))).toBe(false);
    expect(flips["share-net"](turn(["share-pid"]))).toBe(false);
  });

  describe("on a Team Cloud, by the conversation's audience", () => {
    const team = join(dataDir, "workspaces", "bot-a"), miraLayer = join(dataDir, "workspaces", "bot-a--member-p_mira");
    const ask = (audience: BoxAudience, more: Partial<BoxRequest> = {}) => planBox(setup(), { command: "/usr/local/bin/claude", args: [], cwd, env: { HOME: home }, audience, ...more });
    const writesTeamThings = (plan: ReturnType<typeof ask>) => ["MEMORY.md", "memory/2026-11-17.md", "skills/report/SKILL.md", "notes.md"].map((file) => visibleInBox(plan, join(team, file)));

    it("the team's chat writes the bot's own folder, as on any other server", () => {
      const plan = ask({ teamReadOnly: false });
      expect(writesTeamThings(plan)).toEqual(["rw", "rw", "rw", "rw"]);
      expect(visibleInBox(plan, cwd)).toBe("rw");
    });

    it("a member's private chat reads the team's folder but writes only its own folder and its own layer", () => {
      const plan = ask({ teamReadOnly: true }, { rw: [miraLayer] });
      expect(writesTeamThings(plan)).toEqual(["ro", "ro", "ro", "ro"]);
      expect(visibleInBox(plan, join(miraLayer, "MEMORY.md"))).toBe("rw");
      expect(visibleInBox(plan, join(cwd, "draft.md"))).toBe("rw");
      expect(visibleInBox(plan, join(dataDir, "bots", "bot-a", "SOUL.md"))).toBe("ro");
      expect(plan.writable.filter((path) => under(path, team))).toEqual([]);
      // Read-only after every read-write line, so nothing the caller lends can make it writable again.
      const args = bwrapArgs(plan);
      const readOnly = args.findIndex((arg, i) => arg === "--ro-bind-try" && args[i + 1] === team && args[i + 2] === team);
      const lastWritable = args.reduce((last, arg, i) => (arg === "--bind" || arg === "--bind-try") && !args[i + 2]!.startsWith("/run/seira/") ? i : last, -1);
      expect(readOnly).toBeGreaterThan(lastWritable);
      expect(visibleInBox(ask({ teamReadOnly: true }, { rw: [team, join(team, "skills")] }), join(team, "skills", "x", "SKILL.md"))).toBe("ro");
    });

    it("a room's turn in the bot's own folder still makes files there, but the team's notes and skills stay read-only", () => {
      const plan = ask({ teamReadOnly: true }, { cwd: team, rw: [join(dataDir, "workspaces", "bot-a--room-g1")] });
      expect(writesTeamThings(plan)).toEqual(["ro", "ro", "ro", "rw"]);
      expect(visibleInBox(plan, join(dataDir, "workspaces", "bot-a--room-g1", "MEMORY.md"))).toBe("rw");
      expect(writesTeamThings(planBox(setup(), { command: "/usr/local/bin/claude", args: [], cwd: team, env: { HOME: home } }))).toEqual(["rw", "rw", "rw", "rw"]);
    });

    it("a turn in a project folder of its own changes nothing there", () => {
      const plan = ask({ teamReadOnly: true }, { cwd: "/data/projects/site" });
      expect(visibleInBox(plan, "/data/projects/site/index.html")).toBe("rw");
      expect(visibleInBox(plan, join(team, "MEMORY.md"))).toBe("none");
      expect(visibleInBox(ask({ teamReadOnly: true }, { cwd: "/data/projects/site", botId: "bot-a" }), join(team, "MEMORY.md"))).toBe("ro");
    });

    it("every turn has the team's shared folder at /team-files: read-only, or read-write for a bot that may edit it", () => {
      const source = join(dataDir, "team-files");
      const read = ask({ teamReadOnly: true, teamFiles: { source, write: false } });
      expect(visibleInBox(read, "/team-files/payroll/nov.csv")).toBe("ro");
      expect(visibleInBox(read, join(source, "payroll", "nov.csv")), "only at its own path, never where the server keeps it").toBe("none");
      const edit = ask({ teamReadOnly: true, teamFiles: { source, write: true } });
      expect(visibleInBox(edit, "/team-files/payroll/nov.csv")).toBe("rw");
      expect(edit.writable).toContain("/team-files");
      expect(writesTeamThings(edit), "editing team files is not writing the bot's own folder").toEqual(["ro", "ro", "ro", "ro"]);
      expect(bwrapArgs(edit).join(" ")).toContain(`--bind-try ${source} /team-files`);
      expect(visibleInBox(edit, "/team-files/templates/reporter/bot.yaml"), "the team's template library stays the admins'").toBe("ro");
      expect(visibleInBox(ask({ teamReadOnly: false }), "/team-files/x")).toBe("none");
    });

    it("a process the bot's conversations share has only the conversations its audience may read", () => {
      const threads = (rw: string[], ro: string[]) => planBox(setup(), { command: "opencode", args: ["acp"], cwd, env: { HOME: home }, botThreads: true, audience: { teamReadOnly: ro.length > 0, threads: { rw, ro } } });
      const mira = threads(["thread-1", "thread-3"], ["thread-team"]);
      const at = (plan: ReturnType<typeof threads>, path: string) => visibleInBox(plan, join(dataDir, path));
      expect(at(mira, "task-workspaces/bot-a/thread-1/a.md")).toBe("rw");
      expect(at(mira, "task-workspaces/bot-a/thread-3/a.md")).toBe("rw");
      expect(at(mira, "task-workspaces/bot-a/thread-team/a.md")).toBe("ro");
      expect(at(mira, "box-uploads/bot-a/thread-team/photo.png")).toBe("ro");
      expect(at(mira, "box-uploads/bot-a/thread-3/photo.png")).toBe("ro");
      for (const ben of ["task-workspaces/bot-a/thread-ben/notes.md", "box-uploads/bot-a/thread-ben/photo.png", "task-workspaces/bot-b/thread-9/x"]) expect(at(mira, ben), ben).toBe("none");
      expect(at(mira, "workspaces/bot-a/MEMORY.md")).toBe("ro");
      const shared = threads(["thread-1", "thread-team"], []);
      expect(at(shared, "task-workspaces/bot-a/thread-team/a.md")).toBe("rw");
      expect(at(shared, "task-workspaces/bot-a/thread-ben/notes.md")).toBe("none");
      expect(at(shared, "workspaces/bot-a/MEMORY.md")).toBe("rw");
      // Ids that are not a conversation's are never put back.
      expect(at(threads(["thread-1", "../bot-b"], ["../../config"]), "task-workspaces/bot-b/thread-9/x")).toBe("none");
    });
  });

  it("reads the bot and conversation off a task workspace, and absolute paths off the command line", () => {
    expect(taskWorkspaceIds(cwd, dataDir)).toEqual({ botId: "bot-a", threadId: "thread-1" });
    expect(taskWorkspaceIds("/data/projects/x", dataDir)).toBeNull();
    expect(taskWorkspaceIds(join(dataDir, "task-workspaces"), dataDir)).toBeNull();
    expect(taskWorkspaceIds(join(dataDir, "task-workspaces", "../../etc", "x"), dataDir)).toBeNull();
    expect(argvPaths(["-p", "--mcp-config", "/tmp/a/mcp.json", "--additional-mcp-config", "@/tmp/copilot/mcp.json", "--settings=/tmp/b/s.json", "/", "relative/file", "--model", "x"])).toEqual(["/tmp/a/mcp.json", "/tmp/copilot/mcp.json", "/tmp/b/s.json"]);
  });
});

linuxBox("a bot's folder list", () => {
  const folders = (limited: boolean, ...grants: Array<[string, boolean]>) => ({ limited, grants: grants.map(([path, write]) => ({ path, write })) });
  const ask = (given?: BoxRequest["folders"], more: Partial<BoxRequest> = {}, over: Partial<BoxSetup> = {}) =>
    planBox({ ...setup(), ...over }, { command: "/usr/local/bin/claude", args: [], cwd, env: { HOME: home }, ...(given ? { folders: given } : {}), ...more });

  it("a bot with no folder setting gets the same plan as before (AC-17)", () => {
    expect(ask()).toEqual(ask(undefined));
    const bare = planBox(setup(), { command: "/usr/bin/x", args: [], env: {} });
    expect(bare.mounts.slice(0, 18).map((mount) => mount.kind)).toEqual(["ro", "symlink", "symlink", "symlink", "symlink", "ro", "ro", "ro", "ro", "ro", "ro", "proc", "dev", "tmpfs", "tmpfs", "tmpfs", "bind", "tmpfs"]);
    expect(bare.mounts[16]).toEqual({ kind: "bind", source: home, target: home });
    expect(bare.mounts[17]).toEqual({ kind: "tmpfs", target: dataDir });
    expect(bare.writable).toEqual([home]);
    const unlimited = ask({ limited: false, grants: [] });
    expect(unlimited.mounts).toEqual(ask().mounts);
  });

  it("binds a can-change grant read-write and a read-only grant read-only, over a writable HOME (AC-09, AC-10)", () => {
    const plan = ask(folders(false, ["/data/projects/site", true], ["/data/docs", false]));
    expect(visibleInBox(plan, "/data/projects/site/index.html")).toBe("rw");
    expect(visibleInBox(plan, "/data/docs/a.md")).toBe("ro");
    expect(visibleInBox(plan, "/data/other/a.md")).toBe("rw");
    const outside = ask(folders(false, ["/work/shared", false], ["/work/own", true]));
    expect(visibleInBox(outside, "/work/shared/a.md")).toBe("ro");
    expect(visibleInBox(outside, "/work/own/a.md")).toBe("rw");
  });

  it("a read-only grant inside a can-change grant stays read-only (AC-10)", () => {
    const plan = ask(folders(false, ["/work/repo", true], ["/work/repo/secrets", false]));
    expect(visibleInBox(plan, "/work/repo/src/a.ts")).toBe("rw");
    expect(visibleInBox(plan, "/work/repo/secrets/key.txt")).toBe("ro");
    const reversed = ask(folders(false, ["/work/repo/secrets", false], ["/work/repo", true]));
    expect(visibleInBox(reversed, "/work/repo/secrets/key.txt")).toBe("ro");
  });

  it("a can-change grant inside a read-only grant is writable again (AC-10)", () => {
    const plan = ask(folders(true, ["/work/repo", false], ["/work/repo/out", true], ["/work/repo/out/frozen", false]));
    expect(visibleInBox(plan, "/work/repo/src/a.ts")).toBe("ro");
    expect(visibleInBox(plan, "/work/repo/out/a.js")).toBe("rw");
    expect(visibleInBox(plan, "/work/repo/out/frozen/a.js")).toBe("ro");
    const sameBoth = ask(folders(false, ["/work/x", true], ["/work/x", false]));
    expect(visibleInBox(sameBoth, "/work/x/a")).toBe("ro");
  });

  it("never gives back the data folder, a folder in it, or a folder that holds it (AC-11)", () => {
    const plan = ask(folders(false, [dataDir, true], [join(dataDir, "providers"), true], [join(dataDir, "tools"), false], [home, false]));
    for (const hidden of ["messages.db", "config.json", "providers/x", "tools/y"]) expect(visibleInBox(plan, join(dataDir, hidden)), hidden).toBe("none");
    expect(plan.mounts.some((mount) => "source" in mount && mount.source === home && mount.kind === "ro")).toBe(false);
    const apart = ask(folders(true, ["/srv", true]), { cwd: "/srv/seira/task-workspaces/b/t" }, { dataDir: "/srv/seira", engineRoots: engineInstallRoots("/srv/seira") });
    expect(visibleInBox(apart, "/srv/seira/messages.db")).toBe("none");
    expect(visibleInBox(apart, "/srv/other.txt")).toBe("none");
  });

  describe("limited", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "seira-limited-")));
    afterAll(() => rmSync(root, { recursive: true, force: true }));
    const fakeHome = join(root, "home"), fakeData = join(fakeHome, ".seira");
    for (const dir of [".claude/local", ".codex", ".npm-global/bin", ".local/bin", ".config/git", ".ssh", "Documents", "Downloads"]) mkdirSync(join(fakeHome, dir), { recursive: true });
    writeFileSync(join(fakeHome, ".claude.json"), "{}");
    writeFileSync(join(fakeHome, ".gitconfig"), "");
    writeFileSync(join(fakeHome, ".bashrc"), "");
    const fakeCwd = join(fakeData, "task-workspaces", "bot-a", "thread-1");
    const limitedPlan = (...grants: Array<[string, boolean]>) => planBox({ ...setup(), dataDir: fakeData, home: fakeHome, engineRoots: engineInstallRoots(fakeData) }, {
      command: "/usr/local/bin/claude", args: [], cwd: fakeCwd, env: { HOME: fakeHome }, folders: folders(true, ...grants),
    });

    it("hides the rest of HOME and keeps the sign-ins, the programs, the git settings and the grants (AC-09)", () => {
      const plan = limitedPlan([join(fakeHome, "Documents"), false]);
      for (const hidden of [".ssh/id_ed25519", ".bashrc", "Downloads/a.pdf", ".config/other", ".seira/messages.db", ".seira/config.json"]) expect(visibleInBox(plan, join(fakeHome, hidden)), hidden).toBe("none");
      for (const signIn of [".claude/settings.json", ".claude.json", ".codex/auth.json"]) expect(visibleInBox(plan, join(fakeHome, signIn)), signIn).toBe("rw");
      for (const kept of [".npm-global/lib/x.js", ".local/bin/claude", ".gitconfig", ".config/git/ignore"]) expect(visibleInBox(plan, join(fakeHome, kept)), kept).toBe("ro");
      expect(visibleInBox(plan, join(fakeHome, "Documents/a.md"))).toBe("ro");
      expect(visibleInBox(plan, fakeCwd), "the working folder").toBe("rw");
      expect(visibleInBox(plan, join(fakeData, "workspaces", "bot-a", "MEMORY.md")), "the bot's own folder").toBe("rw");
      expect(visibleInBox(plan, join(fakeHome, ".grok/auth.json")), "a sign-in folder that is not there is not bound").toBe("none");
      expect(plan.mounts.filter((mount) => mount.kind === "tmpfs" && mount.target === fakeHome)).toHaveLength(1);
      expect(plan.writable).not.toContain(fakeHome);
    });

    it("leaves out an entry that is a link, or that sits behind one (a link to HOME or to the data folder gives nothing)", () => {
      const tricky = join(root, "tricky"), data = join(tricky, ".seira");
      mkdirSync(join(data, "workspaces"), { recursive: true });
      mkdirSync(join(tricky, "elsewhere"), { recursive: true });
      mkdirSync(join(tricky, ".codex"), { recursive: true });
      symlinkSync(tricky, join(tricky, ".claude"));
      symlinkSync(data, join(tricky, ".gemini"));
      symlinkSync(join(tricky, "elsewhere"), join(tricky, ".local"));
      mkdirSync(join(tricky, "elsewhere", "bin"), { recursive: true });
      symlinkSync(tricky, join(tricky, ".grok"));
      const plan = planBox({ ...setup(), dataDir: data, home: tricky, engineRoots: engineInstallRoots(data) }, {
        command: "claude", args: [], cwd: join(data, "task-workspaces", "bot-a", "t"), env: { HOME: tricky }, folders: folders(true),
      });
      for (const left of [".claude/x", ".gemini/x", ".grok/x", ".local/bin/x", "Notes/x"]) expect(visibleInBox(plan, join(tricky, left)), left).toBe("none");
      expect(visibleInBox(plan, join(tricky, ".codex/auth.json")), "a real folder stays").toBe("rw");
      expect(visibleInBox(plan, join(data, "messages.db"))).toBe("none");
      expect(plan.mounts.some((mount) => "source" in mount && (mount.source === tricky || mount.source === data))).toBe(false);
    });

    it.skipIf(process.platform === "win32")("binds the program folders in a sign-in folder, and each folder there their links pass, read-only after it and every grant", () => {
      const programs = join(root, "programs"), data = join(programs, ".seira");
      for (const dir of [".grok/bin", ".grok/downloads", ".grok/sessions", ".claude/local", ".kimi-code/bin", ".codex"]) mkdirSync(join(programs, dir), { recursive: true });
      writeFileSync(join(programs, ".grok/downloads/grok-1"), "");
      symlinkSync(join("..", "downloads", "grok-1"), join(programs, ".grok/bin/grok"));
      symlinkSync("..", join(programs, ".grok/bin/up"));
      symlinkSync(root, join(programs, ".grok/bin/away"));
      writeFileSync(join(programs, ".claude/local/claude"), "");
      writeFileSync(join(programs, ".kimi-code/bin/kimi"), "");
      const kept = [".claude/local", ".grok/bin", ".grok/downloads", ".kimi-code/bin"].map((name) => join(programs, name));
      expect(signInPrograms(programs, data).readOnly.sort()).toEqual(kept);
      expect(signInPrograms(programs, data).locked).toEqual([]);
      const ask = (...grants: Array<[string, boolean]>) => planBox({ ...setup(), dataDir: data, home: programs, engineRoots: engineInstallRoots(data) }, {
        command: "claude", args: [], cwd: join(data, "task-workspaces", "bot-a", "t"), env: { HOME: programs }, folders: folders(true, ...grants),
      });
      const plan = ask();
      const at = (kind: string, target: string) => plan.mounts.findIndex((mount) => mount.kind === kind && "target" in mount && mount.target === target);
      for (const path of kept) {
        const signIn = join(programs, path.slice(programs.length + 1).split("/")[0]!);
        expect(at("bind", signIn), signIn).toBeGreaterThan(-1);
        expect(at("ro", path), path).toBeGreaterThan(at("bind", signIn));
      }
      for (const path of [".grok/bin/grok", ".grok/downloads/grok-1", ".claude/local/claude", ".kimi-code/bin/kimi"]) expect(visibleInBox(plan, join(programs, path)), path).toBe("ro");
      for (const path of [".grok/auth.json", ".grok/sessions/s.json", ".claude/settings.json", ".kimi-code/config.toml", ".codex/auth.json"]) expect(visibleInBox(plan, join(programs, path)), path).toBe("rw");
      expect(plan.writable).toEqual(expect.arrayContaining([".grok", ".claude", ".kimi-code", ".codex"].map((name) => join(programs, name))));
      for (const path of kept) expect(plan.writable, path).not.toContain(path);
      const granted = ask([join(programs, ".grok"), true], [programs, false], [join(programs, ".claude"), true]);
      for (const path of [".grok/bin/grok", ".grok/downloads/grok-1", ".claude/local/claude"]) expect(visibleInBox(granted, join(programs, path)), `${path}: no grant gives it back`).toBe("ro");
      expect(visibleInBox(granted, join(programs, ".grok/sessions/s.json"))).toBe("rw");
    });

    it.skipIf(process.platform === "win32")("binds each folder a chain of links passes read-only, and the whole sign-in folder when one cannot be", () => {
      const home = join(root, "chain"), data = join(home, ".seira");
      for (const dir of [".grok/bin", ".grok/tmp", ".grok/versions/1.0", ".grok/sessions", ".kimi-code/bin", ".kimi-code/cache"]) mkdirSync(join(home, dir), { recursive: true });
      writeFileSync(join(home, ".grok/versions/1.0/grok"), "");
      symlinkSync(join("..", "tmp", "link"), join(home, ".grok/bin/grok"));
      symlinkSync(join("..", "versions", "1.0", "grok"), join(home, ".grok/tmp/link"));
      writeFileSync(join(home, ".kimi-code/cache/kimi-1"), "");
      symlinkSync("cache", join(home, ".kimi-code/scratch"));
      symlinkSync(join("..", "scratch", "kimi-1"), join(home, ".kimi-code/bin/kimi"));
      const plan = (at: string) => planBox({ ...setup(), dataDir: join(at, ".seira"), home: at, engineRoots: engineInstallRoots(join(at, ".seira")) }, {
        command: "claude", args: [], cwd: join(at, ".seira", "task-workspaces", "bot-a", "t"), env: { HOME: at }, folders: folders(true),
      });
      const found = signInPrograms(home, data);
      expect(found.readOnly.sort()).toEqual([".grok/bin", ".grok/tmp", ".grok/versions", ".kimi-code/bin", ".kimi-code/cache"].map((name) => join(home, name)));
      expect(found.locked, "a link in the chain sits right in the sign-in folder").toEqual([join(home, ".kimi-code")]);
      const chain = plan(home);
      for (const path of [".grok/bin/grok", ".grok/tmp/link", ".grok/versions/1.0/grok"]) expect(visibleInBox(chain, join(home, path)), path).toBe("ro");
      expect(visibleInBox(chain, join(home, ".grok/sessions/s.json"))).toBe("rw");
      for (const path of [".kimi-code/scratch", ".kimi-code/cache/kimi-1", ".kimi-code/config.toml", ".kimi-code/bin/kimi"]) expect(visibleInBox(chain, join(home, path)), path).toBe("ro");
      expect(chain.writable).not.toContain(join(home, ".kimi-code"));

      const missing = join(root, "missing");
      for (const dir of [".grok", ".claude"]) mkdirSync(join(missing, dir), { recursive: true });
      symlinkSync(join(missing, ".claude"), join(missing, ".kimi-code"));
      mkdirSync(join(missing, ".claude", "elsewhere"));
      symlinkSync("elsewhere", join(missing, ".claude", "local"));
      expect(signInPrograms(missing, join(missing, ".seira")).locked.sort(), "a program folder that is not there, or is a link").toEqual([join(missing, ".claude"), join(missing, ".grok")]);
      const locked = plan(missing);
      for (const path of [".grok/bin/grok", ".grok/auth.json", ".claude/local/claude", ".claude/settings.json"]) expect(visibleInBox(locked, join(missing, path)), path).toBe("ro");
      expect(locked.writable.filter((path) => under(path, missing) && !under(path, join(missing, ".seira")))).toEqual([]);
    });

    it("does not give HOME back through an environment path, and non-limited mode is unchanged", () => {
      const env = { HOME: fakeHome, XDG_CONFIG_HOME: join(fakeHome, ".config"), XDG_CACHE_HOME: join(fakeHome, ".cache"), CLAUDE_CONFIG_DIR: join(fakeHome, ".claude", "work"), CODEX_HOME: join(fakeHome, "Documents", "codex") };
      const ask = (given: BoxRequest["folders"]) => planBox({ ...setup(), dataDir: fakeData, home: fakeHome, engineRoots: engineInstallRoots(fakeData) }, { command: "claude", args: [], cwd: fakeCwd, env, ...(given ? { folders: given } : {}) });
      const plan = ask(folders(true, [join(fakeHome, "Documents"), true]));
      expect(visibleInBox(plan, join(fakeHome, ".config/other-app/token"))).toBe("none");
      expect(visibleInBox(plan, join(fakeHome, ".cache/x"))).toBe("none");
      expect(visibleInBox(plan, join(fakeHome, ".claude/work/s.json")), "inside a sign-in folder").toBe("rw");
      expect(visibleInBox(plan, join(fakeHome, "Documents/codex/x")), "inside a grant").toBe("rw");
      expect(plan.mounts.some((mount) => "source" in mount && (mount.source === join(fakeHome, ".config") || mount.source === join(fakeHome, ".cache")))).toBe(false);
      expect(ask(undefined).mounts).toEqual(ask({ limited: false, grants: [] }).mounts);
      expect(visibleInBox(ask({ limited: false, grants: [] }), join(fakeHome, ".config/other-app/token"))).toBe("rw");
    });

    it("never binds a path that holds HOME, from the environment, rw or a lent folder; non-limited mode is unchanged", () => {
      const ask = (given: BoxRequest["folders"], more: Partial<BoxRequest>) => planBox({ ...setup(), dataDir: fakeData, home: fakeHome, engineRoots: engineInstallRoots(fakeData) }, {
        command: "claude", args: [], cwd: fakeCwd, env: { HOME: fakeHome }, ...(given ? { folders: given } : {}), ...more,
      });
      for (const holder of ["/", root, fakeHome, join(fakeHome, "..")]) {
        const plan = ask(folders(true), { env: { HOME: fakeHome, XDG_DATA_HOME: holder }, rw: [holder] });
        expect(visibleInBox(plan, join(fakeHome, ".ssh/id_ed25519")), holder).toBe("none");
        expect(plan.mounts.some((mount) => mount.kind === "bind" && "source" in mount && mount.source === holder), holder).toBe(false);
      }
      const owned = ask(folders(true), { rw: [join(fakeData, "workspaces", "bot-a--member-p_mira")] });
      expect(visibleInBox(owned, join(fakeData, "workspaces", "bot-a--member-p_mira", "MEMORY.md")), "an own folder in the data folder stays").toBe("rw");
      const open = ask(undefined, { rw: [root] });
      expect(visibleInBox(open, join(fakeHome, ".ssh/id_ed25519"))).toBe("rw");
    });

    it("lists the mounts of one read-only grant inside one can-change grant", () => {
      const plan = limitedPlan(["/work/repo", true], ["/work/repo/vendor", false]);
      const lines = plan.mounts.filter((mount) => "source" in mount && mount.source.startsWith("/work")).map((mount) => `${mount.kind} ${"source" in mount ? mount.source : ""}`);
      expect(lines).toEqual(["bind /work/repo", "ro /work/repo/vendor"]);
      expect(plan.mounts.findIndex((mount) => mount.kind === "tmpfs" && mount.target === fakeHome)).toBeLessThan(plan.mounts.findIndex((mount) => "source" in mount && mount.source === "/work/repo"));
    });

    it("on an audience's engine home, limited changes nothing but the grants", () => {
      const own = join(fakeData, "engine-homes", "member-aaaaaaaaaaaaaaaa");
      const plan = planBox({ ...setup(), dataDir: fakeData, home: fakeHome }, { command: "claude", args: [], cwd: fakeCwd, env: { HOME: own }, home: own, folders: folders(true, ["/work/a", true]) });
      expect(visibleInBox(plan, join(own, ".claude", "x"))).toBe("rw");
      expect(visibleInBox(plan, "/work/a/f")).toBe("rw");
      expect(plan.mounts.some((mount) => mount.kind === "tmpfs" && mount.target === fakeHome)).toBe(false);
    });

    it("keeps the code readable when it runs from under HOME, /tmp or /run, and never gives back /tmp, HOME or the data folder (AC-12)", () => {
      const checkout = join(fakeHome, "src", "seira"), appImage = "/tmp/.mount_SeiraX1/resources", runtime = "/run/user/1000/seira";
      for (const dir of ["server", "shared", "node_modules/ajv", "packages/p", "skills/s", ".git", "internal/plan", "brand"]) mkdirSync(join(checkout, dir), { recursive: true });
      for (const file of ["package.json", ".env.local", "AGENTS.local.md", "brand/.env.local"]) writeFileSync(join(checkout, file), "");
      const roots = [checkout, appImage, runtime, "/tmp", fakeHome, fakeData, "/app"];
      const plan = planBox({ ...setup(), codeRoots: roots, dataDir: fakeData, home: fakeHome, engineRoots: engineInstallRoots(fakeData) }, {
        command: "/usr/local/bin/claude", args: [], cwd: fakeCwd, env: { HOME: fakeHome }, folders: folders(true),
      });
      for (const code of [appImage, runtime]) expect(visibleInBox(plan, join(code, "dist-server", "index.js")), code).toBe("ro");
      for (const part of ["server/index.ts", "shared/x.ts", "node_modules/ajv/x.js", "packages/p/x.ts", "skills/s/SKILL.md", "package.json"]) expect(visibleInBox(plan, join(checkout, part)), part).toBe("ro");
      for (const secret of [".env.local", ".git/config", "internal/plan/x.md", "AGENTS.local.md", "brand/.env.local"]) expect(visibleInBox(plan, join(checkout, secret)), secret).toBe("none");
      expect(visibleInBox(plan, "/tmp/other-user-file"), "the host's /tmp").toBe("none");
      expect(visibleInBox(plan, join(fakeHome, ".ssh/id_ed25519"))).toBe("none");
      expect(visibleInBox(plan, join(fakeData, "messages.db"))).toBe("none");
      const unlimited = planBox({ ...setup(), codeRoots: roots, dataDir: fakeData, home: fakeHome, engineRoots: engineInstallRoots(fakeData) }, {
        command: "/usr/local/bin/claude", args: [], cwd: fakeCwd, env: { HOME: fakeHome },
      });
      expect(visibleInBox(unlimited, join(checkout, "x.js")), "HOME stays writable for a box of every bot").toBe("rw");
      expect(visibleInBox(unlimited, join(appImage, "x.js"))).toBe("ro");
    });

    it("reads only a Node install's programs of a code root in HOME, never the rest of it (AC-12)", () => {
      const prefix = join(fakeHome, ".local");
      for (const dir of ["bin", "lib/node_modules/npm", "share/keyrings", "state"]) mkdirSync(join(prefix, dir), { recursive: true });
      const plan = planBox({ ...setup(), codeRoots: [prefix], dataDir: fakeData, home: fakeHome, engineRoots: engineInstallRoots(fakeData) }, {
        command: "/usr/local/bin/claude", args: [], cwd: fakeCwd, env: { HOME: fakeHome }, folders: folders(true),
      });
      for (const code of ["bin/node", "lib/node_modules/npm/index.js"]) expect(visibleInBox(plan, join(prefix, code)), code).toBe("ro");
      for (const hidden of ["share/keyrings/login.keyring", "share/recently-used.xbel", "state/x"]) expect(visibleInBox(plan, join(prefix, hidden)), hidden).toBe("none");
    });

    it("reads the versions Claude's and Cursor's installers keep in .local/share, and nothing else there", () => {
      const own = join(root, "installs"), share = join(own, ".local", "share"), data = join(own, ".seira");
      for (const dir of [join(own, ".local", "bin"), join(share, "claude", "versions"), join(share, "cursor-agent", "versions", "2026.1"), join(share, "keyrings")]) mkdirSync(dir, { recursive: true });
      writeFileSync(join(share, "claude", "versions", "2.1.0"), "");
      writeFileSync(join(share, "keyrings", "login.keyring"), "");
      symlinkSync(join(share, "claude", "versions", "2.1.0"), join(own, ".local", "bin", "claude"));
      const plan = planBox({ ...setup(), dataDir: data, home: own, engineRoots: engineInstallRoots(data) }, {
        command: join(own, ".local", "bin", "claude"), args: [], cwd: join(data, "task-workspaces", "bot-a", "t"), env: { HOME: own }, folders: folders(true),
      });
      for (const kept of ["claude/versions/2.1.0", "cursor-agent/versions/2026.1/cursor-agent"]) expect(visibleInBox(plan, join(share, kept)), kept).toBe("ro");
      for (const hidden of ["keyrings/login.keyring", "claude/other", "recently-used.xbel"]) expect(visibleInBox(plan, join(share, hidden)), hidden).toBe("none");
    });

    it("leaves out a part of a code root in HOME that is a link", () => {
      const checkout = join(root, "linked-checkout");
      mkdirSync(join(checkout, "server"), { recursive: true });
      symlinkSync(fakeHome, join(checkout, "skills"));
      symlinkSync(fakeData, join(checkout, "shared"));
      const inHome = join(fakeHome, "src", "linked");
      mkdirSync(join(fakeHome, "src"), { recursive: true });
      symlinkSync(checkout, inHome);
      const plan = planBox({ ...setup(), codeRoots: [inHome], dataDir: fakeData, home: fakeHome, engineRoots: engineInstallRoots(fakeData) }, {
        command: "/usr/local/bin/claude", args: [], cwd: fakeCwd, env: { HOME: fakeHome }, folders: folders(true),
      });
      expect(plan.mounts.some((mount) => "source" in mount && (mount.source === fakeHome || mount.source === fakeData))).toBe(false);
      expect(visibleInBox(plan, join(inHome, "skills", ".ssh", "id_ed25519"))).toBe("none");
    });

    it("gives a code root in a HOME under /tmp only its parts, and a box of every bot keeps HOME writable (AC-12)", () => {
      const tmpRoot = realpathSync(mkdtempSync(join("/tmp", "seira-home-in-tmp-")));
      try {
        const tmpHome = join(tmpRoot, "home"), tmpData = join(tmpHome, ".seira"), checkout = join(tmpHome, "src", "seira");
        for (const dir of [join(checkout, "server"), join(checkout, ".git"), join(tmpData, "workspaces")]) mkdirSync(dir, { recursive: true });
        writeFileSync(join(checkout, ".env.local"), "");
        const ask = (given?: BoxRequest["folders"]) => planBox({ ...setup(), codeRoots: [checkout], dataDir: tmpData, home: tmpHome, engineRoots: engineInstallRoots(tmpData) }, {
          command: "/usr/local/bin/claude", args: [], cwd: join(tmpData, "task-workspaces", "bot-a", "t"), env: { HOME: tmpHome }, ...(given ? { folders: given } : {}),
        });
        const plan = ask(folders(true));
        expect(visibleInBox(plan, join(checkout, "server", "index.ts"))).toBe("ro");
        for (const secret of [".env.local", ".git/config"]) expect(visibleInBox(plan, join(checkout, secret)), secret).toBe("none");
        expect(visibleInBox(ask(), join(checkout, ".env.local"))).toBe("rw");
      } finally {
        rmSync(tmpRoot, { recursive: true, force: true });
      }
    });

    it("gives a limited box nothing more through a configured server's command line", () => {
      const key = join(fakeHome, "Documents", "brief.md");
      const ask = (configured: boolean) => planBox({ ...setup(), dataDir: fakeData, home: fakeHome, engineRoots: engineInstallRoots(fakeData) }, {
        command: "/usr/bin/cat", args: [key], cwd: fakeCwd, env: { HOME: fakeHome }, folders: folders(true), configured,
      });
      expect(visibleInBox(ask(true), key)).toBe("none");
      expect(visibleInBox(ask(false), key), "a command line the server built is unchanged").toBe("ro");
      const outside = planBox({ ...setup(), dataDir: fakeData, home: fakeHome, engineRoots: engineInstallRoots(fakeData) }, {
        command: "/usr/bin/cat", args: ["/srv/data/x.csv", "/"], cwd: fakeCwd, env: { HOME: fakeHome }, folders: folders(true), configured: true,
      });
      for (const path of ["/srv/data/x.csv", "/srv/other"]) expect(visibleInBox(outside, path), path).toBe("none");
    });

    it("reads its conversation's uploads when a limited bot works in a folder of its own choosing (AC-09)", () => {
      const plan = planBox({ ...setup(), dataDir: fakeData, home: fakeHome, engineRoots: engineInstallRoots(fakeData) }, {
        command: "/usr/local/bin/claude", args: [], cwd: "/work/repo", botId: "bot-a", threadId: "thread-1", env: { HOME: fakeHome }, folders: folders(true, ["/work/repo", true]),
      });
      expect(visibleInBox(plan, join(fakeData, "box-uploads", "bot-a", "thread-1", "a.png")), "the uploads folder, read-only").toBe("ro");
      expect(visibleInBox(plan, join(fakeData, "box-uploads", "bot-b", "thread-1", "a.png"))).toBe("none");
      const other = planBox({ ...setup(), dataDir: fakeData, home: fakeHome, engineRoots: engineInstallRoots(fakeData) }, {
        command: "/usr/local/bin/claude", args: [], cwd: "/work/repo", botId: "bot-a", threadId: "../bot-b/thread-1", env: { HOME: fakeHome }, folders: folders(true, ["/work/repo", true]),
      });
      expect(other.mounts.some((mount) => "source" in mount && mount.source.includes("bot-b"))).toBe(false);
    });

    it("with limited off, HOME stays and only the grants are added", () => {
      const plan = planBox({ ...setup(), dataDir: fakeData, home: fakeHome, engineRoots: engineInstallRoots(fakeData) }, {
        command: "claude", args: [], cwd: fakeCwd, env: { HOME: fakeHome }, folders: folders(false, [join(fakeHome, "Documents"), false]),
      });
      expect(visibleInBox(plan, join(fakeHome, ".ssh/id_ed25519"))).toBe("rw");
      expect(visibleInBox(plan, join(fakeHome, "Documents/a.md"))).toBe("ro");
    });
  });
});
