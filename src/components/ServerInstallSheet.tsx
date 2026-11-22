import { useEffect, useRef, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import type { ServerInstallEvent } from "@/types/ogb";
import { productName } from "@/lib/brand";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { ACTIONS, BackLink, Checklist, FIELD, Heading, LINK, PRIMARY_WIDE, QUIET_WIDE } from "./cloud-buy/parts";

type Method = "password" | "key" | "agent";
type Check = { id: string; level: "ok" | "fix" | "note"; sentence: string };
type Step = { id: string; state: "now" | "done"; sentence: string | null };
type Failed = { reason: string; step: string | null; sentence: string | null; source: "saved" | "system" | "both" | null };
type Screen =
  | { name: "form" }
  | { name: "working"; phase: string }
  | { name: "hostKey"; host: string; fingerprint: string }
  | { name: "checks"; items: Check[]; ok: boolean }
  | { name: "install"; steps: Step[]; email: string | null; again: boolean }
  | ({ name: "failed" } & Failed);

const PHASE_KEY: Record<string, LocaleKey> = {
  connecting: "serverInstall.phase.connecting", rights: "serverInstall.phase.rights", upload: "serverInstall.phase.upload",
  checking: "serverInstall.phase.checking", installing: "serverInstall.phase.installing",
};
const FAILURE_KEY: Record<string, LocaleKey> = {
  address: "serverInstall.fail.address", user: "serverInstall.fail.user", email: "serverInstall.fail.email", auth: "serverInstall.fail.auth",
  keyUnreadable: "serverInstall.fail.keyUnreadable", keyNeedsPassphrase: "serverInstall.fail.keyNeedsPassphrase", keyPassphrase: "serverInstall.fail.keyPassphrase",
  keyOldFormat: "serverInstall.fail.keyOldFormat",
  unreachable: "serverInstall.fail.unreachable", timeout: "serverInstall.fail.timeout", hostKeyChanged: "serverInstall.fail.hostKeyChanged",
  hostKeyDeclined: "serverInstall.fail.hostKeyDeclined", notAdmin: "serverInstall.fail.notAdmin", sudoPassword: "serverInstall.fail.sudoPassword",
  upload: "serverInstall.fail.upload", dropped: "serverInstall.fail.dropped", installer: "serverInstall.fail.installer", pairFailed: "serverInstall.fail.pairFailed",
};
const CHECK_KEY: Record<string, LocaleKey> = {
  os: "serverInstall.check.os", arch: "serverInstall.check.arch", cpu: "serverInstall.check.cpu", memory: "serverInstall.check.memory", disk: "serverInstall.check.disk",
  docker: "serverInstall.check.docker", "docker-install": "serverInstall.check.docker-install", outbound: "serverInstall.check.outbound",
  userns: "serverInstall.check.userns", apparmor: "serverInstall.check.apparmor", clock: "serverInstall.check.clock",
  version: "serverInstall.check.version", account: "serverInstall.check.account",
};
const STEP_KEY: Record<string, LocaleKey> = {
  docker: "serverInstall.step.docker", files: "serverInstall.step.files", image: "serverInstall.step.image", sandbox: "serverInstall.step.sandbox",
  signin: "serverInstall.step.signin", start: "serverInstall.step.start", health: "serverInstall.step.health", tunnel: "serverInstall.step.tunnel",
  pair: "serverInstall.step.pair",
};
const shellWord = (word: string) => (/^[\w.@%+=:,/-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`);
const own = (map: Record<string, LocaleKey>, id: string) => (Object.hasOwn(map, id) ? map[id] : undefined);
const checkLabel = (id: string) => t(own(CHECK_KEY, id) ?? "serverInstall.check.unknown");
const stepLabel = (id: string) => t(own(STEP_KEY, id) ?? "serverInstall.step.unknown");
const checkRows = (items: { id: string; level: string }[]) => {
  const rows = new Map<string, "next" | "done">();
  for (const item of items) rows.set(item.id, item.level === "fix" || rows.get(item.id) === "next" ? "next" : "done");
  return Array.from(rows, ([id, state]) => ({ key: id, state, title: checkLabel(id) }));
};

function Details({ sentences }: { sentences: string[] }) {
  if (!sentences.length) return null;
  return <details data-install-details className="text-[13px] text-ink-secondary">
    <summary className="cursor-pointer">{t("serverInstall.details")}</summary>
    <ul className="mt-1 flex flex-col gap-1">{sentences.map((sentence, index) => <li key={`${index}-${sentence}`} className="break-words">{sentence}</li>)}</ul>
  </details>;
}

const METHOD_KEY: Record<Method, LocaleKey> = { password: "serverInstall.method.password", key: "serverInstall.method.key", agent: "serverInstall.method.agent" };

export function ServerInstallSheet({ onBack, onConnected }: { onBack: (() => void) | null; onConnected: () => void }) {
  const bridge = window.ogb?.serverInstall;
  const [screen, setScreen] = useState<Screen>({ name: "form" });
  const [address, setAddress] = useState("");
  const [user, setUser] = useState("root");
  const [email, setEmail] = useState("");
  const [method, setMethod] = useState<Method>("password");
  const [password, setPassword] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [keyFile, setKeyFile] = useState<{ name: string } | null>(null);
  const [agent, setAgent] = useState(false);
  const [installDocker, setInstallDocker] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const done = useRef(onConnected);
  done.current = onConnected;

  useEffect(() => { void bridge?.info().then(info => setAgent(info.agent)).catch(() => {}); }, [bridge]);
  useEffect(() => bridge?.onEvent((event: ServerInstallEvent) => {
    switch (event.type) {
      case "phase": setScreen(current => current.name === "install" ? current : { name: "working", phase: event.phase }); break;
      case "hostKey": setScreen({ name: "hostKey", host: event.host, fingerprint: event.fingerprint }); break;
      case "checks": setScreen({ name: "checks", items: event.items, ok: event.result === "ok" }); break;
      case "step": setScreen(current => {
        const steps = current.name === "install" ? current.steps : [];
        return { name: "install", email: null, again: current.name === "install" && current.again,
          steps: [...steps.filter(step => step.id !== event.id), { id: event.id, state: event.state === "start" ? "now" : "done", sentence: event.sentence }] };
      }); break;
      case "askCode": setCode(""); setScreen(current => ({ name: "install", steps: current.name === "install" ? current.steps : [], email: event.email, again: event.again === true })); break;
      case "connected": done.current(); break;
      case "cancelled": setKeyFile(null); setScreen({ name: "form" }); break;
      case "failed": setScreen({ name: "failed", reason: event.reason, step: event.step, sentence: event.sentence, source: event.source ?? null }); break;
      default: break;
    }
  }), [bridge]);
  useEffect(() => () => { void bridge?.cancel().catch(() => {}); }, [bridge]);
  if (!bridge) return null;

  const hasSecret = method === "password" ? Boolean(password) : method === "key" ? Boolean(keyFile) : true;
  const ready = Boolean(address.trim() && user.trim() && email.trim() && hasSecret);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || busy) return;
    const request = { address: address.trim(), user: user.trim(), email: email.trim(), method,
      ...(method === "password" ? { password } : {}),
      ...(method === "key" && passphrase ? { passphrase } : {}),
      ...(method !== "password" && adminPassword ? { sudoPassword: adminPassword } : {}) };
    setPassword(""); setAdminPassword(""); setPassphrase("");
    setBusy(true);
    setScreen({ name: "working", phase: "connecting" });
    try { await bridge.start(request); } catch { setScreen({ name: "failed", reason: "unreachable", step: null, sentence: null, source: null }); } finally { setBusy(false); }
  };
  const cancel = () => { void bridge.cancel().catch(() => {}); setKeyFile(null); setScreen({ name: "form" }); };
  const sendCode = async (event: FormEvent) => {
    event.preventDefault();
    const digits = code.replace(/\D/g, "");
    if (digits.length !== 8) return;
    setCode("");
    await bridge.sendCode(digits).catch(() => {});
  };
  const pickKey = async () => { const picked = await bridge.pickKey().catch(() => null); if (picked) setKeyFile(picked); };

  const frame = "flex flex-col gap-4 px-[30px] pb-[26px] pt-7";
  const methods: Method[] = agent ? ["password", "key", "agent"] : ["password", "key"];

  if (screen.name === "form") return <form data-server-install="form" onSubmit={(event) => void submit(event)} className={frame}>
    {onBack && <div><BackLink label={t("rail.back")} onClick={onBack} /></div>}
    <Heading title={t("serverInstall.title")} sub={t("serverInstall.lede", { app: productName() })} />
    <label className="flex flex-col gap-1.5 text-[13px] font-medium text-ink">{t("serverInstall.address")}
      <input data-autofocus data-install-address value={address} onChange={(event) => setAddress(event.target.value)} className={FIELD} autoCapitalize="none" autoCorrect="off" autoComplete="off" spellCheck={false} />
    </label>
    <label className="flex flex-col gap-1.5 text-[13px] font-medium text-ink">{t("serverInstall.user")}
      <input data-install-user value={user} onChange={(event) => setUser(event.target.value)} className={FIELD} autoCapitalize="none" autoCorrect="off" autoComplete="off" spellCheck={false} />
    </label>
    <fieldset className="flex flex-col gap-2 text-[13px] text-ink">
      <legend className="mb-1 font-medium">{t("serverInstall.method")}</legend>
      {methods.map(value => <label key={value} className="flex items-center gap-2">
        <input type="radio" name="install-method" data-install-method={value} checked={method === value} onChange={() => setMethod(value)} />{t(METHOD_KEY[value])}
      </label>)}
    </fieldset>
    {method === "password" && <label className="flex flex-col gap-1.5 text-[13px] font-medium text-ink">{t("serverInstall.password")}
      <input data-install-password type="password" value={password} onChange={(event) => setPassword(event.target.value)} className={FIELD} autoComplete="off" />
    </label>}
    {method === "key" && <div className="flex flex-col gap-2 text-[13px] font-medium text-ink">
      <span>{t("serverInstall.keyFile")}</span>
      <div className="flex items-center gap-3">
        <button type="button" data-install-pick-key onClick={() => void pickKey()} className="ui-button ui-button-pill">{t("serverInstall.chooseKey")}</button>
        <span data-install-key-name className="min-w-0 truncate font-normal text-ink-secondary">{keyFile?.name ?? t("serverInstall.noKey")}</span>
      </div>
      <label className="flex flex-col gap-1.5">{t("serverInstall.passphrase")}
        <input data-install-passphrase type="password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} className={FIELD} autoComplete="off" />
      </label>
    </div>}
    {method !== "password" && <label className="flex flex-col gap-1.5 text-[13px] font-medium text-ink">{t("serverInstall.adminPassword")}
      <input data-install-admin-password type="password" value={adminPassword} onChange={(event) => setAdminPassword(event.target.value)} className={FIELD} autoComplete="off" />
    </label>}
    <label className="flex flex-col gap-1.5 text-[13px] font-medium text-ink">{t("serverInstall.email", { app: productName() })}
      <input data-install-email type="email" value={email} onChange={(event) => setEmail(event.target.value)} className={FIELD} autoCapitalize="none" autoComplete="off" />
    </label>
    <p className="text-[12px] leading-4 text-ink-secondary">{t("serverInstall.notSaved")}</p>
    <div><button type="submit" data-install-start disabled={!ready} className={PRIMARY_WIDE}>{t("serverInstall.connect")}</button></div>
  </form>;

  const head = <Heading title={t("serverInstall.title")} />;
  if (screen.name === "working") return <div data-server-install="working" className={frame}>
    {head}
    <p role="status" className="inline-flex items-center gap-2 text-[14px] text-ink-secondary"><Loader2 size={15} className="animate-spin" aria-hidden="true" />{t(PHASE_KEY[screen.phase] ?? "serverInstall.phase.connecting")}</p>
    <div className={ACTIONS}><button type="button" data-install-cancel onClick={cancel} className={LINK}>{t("serverInstall.cancel")}</button></div>
  </div>;

  if (screen.name === "hostKey") return <div data-server-install="host-key" className={frame}>
    <Heading title={t("serverInstall.hostKey.title")} sub={t("serverInstall.hostKey.sub", { host: screen.host })} />
    <code data-install-fingerprint className="break-all rounded-md bg-inset px-2 py-1.5 font-mono text-[12px] text-ink">{screen.fingerprint}</code>
    <div className="flex flex-col gap-2">
      <button type="button" data-install-accept onClick={() => void bridge.acceptHostKey()} className={PRIMARY_WIDE}>{t("serverInstall.hostKey.accept")}</button>
      <button type="button" data-install-decline onClick={() => void bridge.rejectHostKey()} className={QUIET_WIDE}>{t("serverInstall.hostKey.decline")}</button>
    </div>
  </div>;

  if (screen.name === "checks") {
    const fixes = screen.items.filter(item => item.level === "fix");
    const dockerOnly = fixes.length === 1 && fixes[0]!.id === "docker-install";
    return <div data-server-install="checks" className={frame}>
      <Heading title={t(screen.ok ? "serverInstall.checks.ok" : "serverInstall.checks.fix")} />
      <Checklist label={t("serverInstall.checks.label")} items={checkRows(screen.items)} />
      <Details sentences={screen.items.map(item => item.sentence).filter((sentence): sentence is string => Boolean(sentence))} />
      {dockerOnly && <label className="flex items-center gap-2 text-[13px] text-ink">
        <input type="checkbox" data-install-docker checked={installDocker} onChange={(event) => setInstallDocker(event.target.checked)} />{t("serverInstall.docker")}
      </label>}
      <div className="flex flex-col gap-2">
        <button type="button" data-install-run disabled={!screen.ok && !(dockerOnly && installDocker)}
          onClick={() => void bridge.install({ installDocker })} className={PRIMARY_WIDE}>{t("serverInstall.install")}</button>
        <button type="button" data-install-recheck onClick={() => void bridge.check()} className={QUIET_WIDE}>{t("serverInstall.checkAgain")}</button>
      </div>
    </div>;
  }

  if (screen.name === "install") return <div data-server-install="install" className={frame}>
    {head}
    <Checklist label={t("serverInstall.progress")} items={screen.steps.map((step, index) => ({ key: `${index}-${step.id}`, state: step.state, title: stepLabel(step.id) }))} />
    <Details sentences={screen.steps.map(step => step.sentence).filter((sentence): sentence is string => Boolean(sentence))} />
    {screen.email && <form data-install-code-form onSubmit={(event) => void sendCode(event)} className="flex flex-col gap-2">
      {screen.again && <p role="alert" data-install-code-again className="text-[13px] text-danger">{t("serverInstall.codeAgain")}</p>}
      <label className="flex flex-col gap-1.5 text-[13px] font-medium text-ink">{t("serverInstall.code", { email: screen.email })}
        <input data-autofocus data-install-code inputMode="numeric" value={code} onChange={(event) => setCode(event.target.value)} placeholder="12345678" className={FIELD} autoComplete="off" />
      </label>
      <button type="submit" disabled={code.replace(/\D/g, "").length !== 8} className={PRIMARY_WIDE}>{t("serverInstall.sendCode")}</button>
    </form>}
    <div className={ACTIONS}><button type="button" data-install-cancel onClick={cancel} className={LINK}>{t("serverInstall.cancel")}</button></div>
  </div>;

  return <div data-server-install="failed" className={frame}>
    {head}
    <p role="alert" data-install-problem className="text-[13px] text-danger">{t(FAILURE_KEY[screen.reason] ?? "serverInstall.fail.installer")}</p>
    {screen.reason === "keyOldFormat" && keyFile && <code data-install-key-convert className="break-all rounded-md bg-inset px-2 py-1.5 font-mono text-[12px] text-ink">{`ssh-keygen -p -f ${shellWord(keyFile.name)}`}</code>}
    {screen.step && own(STEP_KEY, screen.step) && <p data-install-failed-step className="text-[13px] text-ink-secondary">{t("serverInstall.failedStep", { step: stepLabel(screen.step) })}</p>}
    <Details sentences={screen.sentence ? [screen.sentence] : []} />
    {screen.reason === "hostKeyChanged" && screen.source === "saved" && <>
      <p data-install-rebuilt-warning className="text-[13px] text-ink-secondary">{t("serverInstall.rebuiltWarning")}</p>
      <button type="button" data-install-rebuilt onClick={() => void bridge.forgetHost()} className={QUIET_WIDE}>{t("serverInstall.rebuilt")}</button>
    </>}
    {screen.reason === "hostKeyChanged" && (screen.source === "system" || screen.source === "both") && <p data-install-system-list className="text-[13px] text-ink-secondary">{t("serverInstall.systemList")}</p>}
    <button type="button" data-install-retry onClick={() => { setKeyFile(null); setScreen({ name: "form" }); }} className={PRIMARY_WIDE}>{t("serverInstall.retry")}</button>
  </div>;
}
