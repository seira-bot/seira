import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { appVersion } from "@/lib/app-links";
import { setLocale } from "@/lib/i18n";
import { AboutDialog, aboutVersionLines } from "./AboutDialog";

function about(page: object): string {
  vi.stubGlobal("window", page);
  return renderToStaticMarkup(createElement(AboutDialog, { open: true, onClose: () => {} }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  setLocale("en");
});

describe("About", () => {
  it("links the Privacy Policy and the Terms of Service with the other links", () => {
    const html = about({ ogb: { platform: "linux", app: { version: "0.1.127", ownPage: true } }, location: { host: "127.0.0.1:8799" } });
    expect(html).toContain('data-legal-link="https://seira.bot/privacy"');
    expect(html).toContain(">Privacy Policy</button>");
    expect(html).toContain('data-legal-link="https://seira.bot/terms"');
    expect(html).toContain(">Terms of Service</button>");
  });

  it("in the app on this computer, shows the app's own version on one line", () => {
    const html = about({ ogb: { platform: "darwin", app: { version: "0.1.127", ownPage: true } }, location: { host: "127.0.0.1:8799" } });
    expect(html).toContain(">Version 0.1.127 · macOS</p>");
    expect(html).not.toContain("Connected to");
  });

  it("in the app on another server, shows the app's own version and names that server with the version it runs", () => {
    const html = about({ ogb: { platform: "darwin", app: { version: "0.1.127", ownPage: false } }, location: { host: "bots.example.test" } });
    expect(html).toContain(">Version 0.1.127 · macOS</p>");
    expect(html).toContain(`>Connected to bots.example.test · version ${appVersion()}</p>`);
  });

  it("in a browser, keeps the page's version on one line", () => {
    const html = about({ location: { host: "bots.example.test" } });
    expect(html).toContain(`>Version ${appVersion()}</p>`);
    expect(html).not.toContain("Connected to");
  });

  it("in an app too old to say which version it is, keeps the page's version as before", () => {
    const html = about({ ogb: { platform: "darwin" }, location: { host: "bots.example.test" } });
    expect(html).toContain(`>Version ${appVersion()} · macOS</p>`);
    expect(html).not.toContain("Connected to");
  });

  it("describes the app without naming the project it is built on; the license files carry the attribution", () => {
    const html = about({ location: { host: "bots.example.test" } });
    expect(html).toContain("A desktop home for your agents: open source, Apache 2.0 licensed.");
    expect(html).not.toContain("OpenMausBot");
    expect(html).toContain(">License</button>");
    setLocale("pt-br");
    expect(about({ location: { host: "bots.example.test" } })).not.toContain("OpenMausBot");
  });

  it("names the server as it was saved, in the person's language", () => {
    const app = { version: "0.1.127", ownPage: false };
    expect(aboutVersionLines({ app, bundle: "0.1.116", platform: "macOS", server: "Office Mac" })).toEqual([
      "Version 0.1.127 · macOS",
      "Connected to Office Mac · version 0.1.116",
    ]);
    setLocale("de");
    expect(aboutVersionLines({ app, bundle: "0.1.116", platform: "macOS", server: "Office Mac" })).toEqual([
      "Version 0.1.127 · macOS",
      "Verbunden mit Office Mac · Version 0.1.116",
    ]);
  });
});
