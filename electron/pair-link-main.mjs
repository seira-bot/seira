// Main's side of a pair link (pair-link.mjs): the questions and the error go through main's own native dialogs, never a page's.
import { createPairLinks } from "./pair-link.mjs";
import { EXAMPLE_ADDRESS } from "./server-address.mjs";
import { CONNECT_PROBLEM_KEYS } from "./server-probe.mjs";

/**
 * @param {{
 *   dialog: { showMessageBox(options: object): Promise<{ response: number }> },
 *   t(key: string, params?: Record<string, string>): string,
 *   argv: string[],
 *   connect(link: { address: string }, confirm: (shown: { origin: string }) => Promise<boolean>): Promise<boolean>,
 *   reveal(): void,
 * }} deps `argv`: this launch's command line; a pair link in it is taken out. `ready()` of the result: call it once a window can show a dialog.
 */
export function installPairLinks({ dialog, t, argv, connect, reveal }) {
  let ready = () => {};
  // The dialog names the normalized origin before any request goes out. Cancel is the default button.
  const confirm = async ({ origin }) => (await dialog.showMessageBox({ type: "question", buttons: [t("native.dialog.connect.button"), t("native.common.cancel")], defaultId: 1, cancelId: 1,
    message: t("native.dialog.connect.title", { host: origin }), detail: t("native.dialog.connect.noCode") })).response === 0;
  const links = createPairLinks({
    ready: new Promise((resolve) => { ready = resolve; }), reveal, connect: (link) => connect(link, confirm),
    invalid: () => new Error(t(CONNECT_PROBLEM_KEYS.notAnAddress, { host: "", example: EXAMPLE_ADDRESS })),
    fail: async (error) => { await dialog.showMessageBox({ type: "info", message: t("native.dialog.connectFailed.title"), detail: `${error.message}\n${t("native.dialog.connectFailed.detail")}` }); },
  });
  links.fromArgs(argv);
  return { fromUrl: (url) => links.fromUrl(url), fromArgs: (commandLine) => links.fromArgs(commandLine), ready: () => ready() };
}
