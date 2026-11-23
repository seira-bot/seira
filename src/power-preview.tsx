// Dev-only gallery of the power button, served at /power-preview.html; not in the packaged app.
// ?state=closed|pill|hold|paused|update|waiting|visor-restart|visor-update|visor-shutdown|wake
// &skin=midnight|daylight&reduced=1&still=1&lang=pt-br&rtl=1
import { useEffect, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { MessageSquare, Settings } from "lucide-react";
import { PowerButton } from "@/components/power/PowerButton";
import { PowerHost } from "@/components/power/PowerHost";
import { loadLocale } from "@/lib/i18n";
import { rememberWake, requestPower, runPower } from "@/lib/power";
import { SKIN_IDS, type SkinId } from "@/lib/skins";
import { BotEditorStore } from "@/state/store";
import "./styles.css";

const params = new URLSearchParams(location.search);
const state = params.get("state") ?? "pill";
const skin = (SKIN_IDS as readonly string[]).includes(params.get("skin") ?? "") ? params.get("skin") as SkinId : "midnight";
document.documentElement.dataset.skin = skin;
if (params.get("reduced") === "1") document.documentElement.dataset.reducedMotion = "true";
if (params.get("rtl") === "1") document.documentElement.dir = "rtl";
if (params.get("still") === "1") document.body.classList.add("power-still");

const never = () => new Promise<void>(() => {});
const updateState = state === "update" || state === "visor-update" ? { status: "downloaded", version: "0.1.191" } : null;
Object.assign(window, {
  ogb: { relaunch: never, quit: never, remoteClient: { active: true }, updater: { install: never, onState: (listener: (value: unknown) => void) => { listener(updateState); return () => {}; } } },
});
const realFetch = window.fetch.bind(window);
window.fetch = (input, init) => String(input).includes("/api/paused") ? Promise.resolve(Response.json({ stopped: 0 })) : realFetch(input, init);

const BOTS = [{ id: "ada", activity: "working", busy: true }, { id: "grace", activity: "working", busy: true }, { id: "linus", activity: "idle" }];
const bots = state === "waiting" ? BOTS : [BOTS[2]!];
const config = { pausedByPerson: { bots: [], departments: [], ...(state === "paused" ? { all: true as const } : {}) } };
const store = { state: { config, bots, groups: [] }, dispatch: () => {}, flushBotPatches: async () => {}, refreshInstances: async () => {}, refreshModels: async () => {} } as unknown as ComponentProps<typeof BotEditorStore>["value"];

function MockApp() {
  return <div className="flex h-screen bg-canvas text-ink">
    <aside className="flex w-[72px] flex-col items-center gap-2 border-e border-hairline bg-panel py-4">
      <div className="grid size-9 place-items-center rounded-full bg-card"><MessageSquare size={18} aria-hidden="true" /></div>
      <div className="flex-1" />
      <button type="button" aria-label="Settings" className="grid size-9 place-items-center rounded-full text-ink-secondary"><Settings size={18} aria-hidden="true" /></button>
      <PowerButton />
    </aside>
    <main className="flex flex-1 flex-col gap-3.5 p-10">
      {[58, 44, 36, 62, 30].map((width, index) => <div key={index} className={`h-3.5 rounded-md ${index === 2 ? "self-end bg-raised" : "bg-card"}`} style={{ width: `${width}%` }} />)}
    </main>
  </div>;
}

const hold = (element: Element | null) => element?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1 }));

function Driver() {
  useEffect(() => {
    const open = () => document.querySelector<HTMLButtonElement>("[data-power-button]")?.click();
    const later = (run: () => void, ms: number) => void setTimeout(run, ms);
    const nothing = { deps: { relaunch: never, quit: never, install: never } };
    if (["pill", "hold", "paused", "update", "waiting"].includes(state)) later(open, 50);
    if (state === "hold") later(() => hold(document.querySelector('[data-power-action="restart"]')), 150);
    if (state === "waiting") later(() => requestPower("restart", { update: null, working: 2 }), 150);
    if (state === "visor-restart") later(() => void runPower("restart", null, nothing.deps), 50);
    if (state === "visor-update") later(() => void runPower("restart", { version: "0.1.191" }, nothing.deps), 50);
    if (state === "visor-shutdown") later(() => void runPower("shutdown", null, nothing.deps), 50);
  }, []);
  return null;
}

if (state === "wake") rememberWake({ kind: params.get("update") === "1" ? "update" : "restart", version: "0.1.191", at: Date.now() });
await loadLocale(params.get("lang") ?? "en");
createRoot(document.getElementById("root")!).render(
  <BotEditorStore value={store}>
    <MockApp />
    <PowerHost />
    <Driver />
  </BotEditorStore>,
);
