// Stands in for agent-browser. It answers the three commands the signed-in sites code sends, against a real Chromium's DevTools address.
import { readFileSync, writeFileSync } from "node:fs";

const [addressFile, ...args] = process.argv.slice(2);
const reply = (data) => process.stdout.write(`${JSON.stringify({ success: true, data })}\n`);
const address = () => readFileSync(addressFile, "utf8").trim();

async function browserCookies() {
  const socket = new WebSocket(address());
  await new Promise((open, fail) => {
    socket.addEventListener("open", open);
    socket.addEventListener("error", () => fail(new Error("The browser did not answer.")));
  });
  const answer = new Promise((done) => socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id === 1) done(message.result?.cookies ?? []);
  }));
  socket.send(JSON.stringify({ id: 1, method: "Storage.getCookies", params: {} }));
  const cookies = await answer;
  socket.close();
  return cookies;
}

if (args[0] === "session" && args[1] === "list") reply({ sessions: [process.env.AGENT_BROWSER_SESSION] });
else if (args[0] === "get" && args[1] === "cdp-url") reply({ cdpUrl: address() });
else if (args[0] === "state" && args[1] === "save") {
  writeFileSync(args[2], JSON.stringify({ cookies: await browserCookies(), origins: [] }));
  reply({});
}
