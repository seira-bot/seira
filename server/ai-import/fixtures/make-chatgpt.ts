import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { once } from "node:events";
import { join } from "node:path";

export interface SyntheticExport {
  path: string;
  bytes: number;
  conversations: number;
}

const PARAGRAPH = "Synthetic line with ünïcode, “quotes”, a \\ backslash and {braces} [brackets]: ".repeat(24);
const MESSAGES = 120;

function conversationTemplate(): string {
  const mapping: Record<string, unknown> = { root: { id: "root", message: null, parent: null, children: ["m0"] } };
  for (let i = 0; i < MESSAGES; i++) {
    const id = `m${i}`;
    mapping[id] = {
      id,
      parent: i === 0 ? "root" : `m${i - 1}`,
      children: i + 1 < MESSAGES ? [`m${i + 1}`] : [],
      message: {
        id,
        author: { role: i % 2 === 0 ? "user" : "assistant" },
        create_time: 1_700_000_000 + i,
        weight: 1,
        metadata: {},
        recipient: "all",
        content: { content_type: "text", parts: [`${PARAGRAPH} #${i}`] },
      },
    };
  }
  return JSON.stringify({
    title: "Synthetic chat __ID__",
    create_time: 1_700_000_000,
    update_time: 1_700_000_500,
    conversation_id: "__ID__",
    id: "__ID__",
    current_node: `m${MESSAGES - 1}`,
    mapping,
  });
}

/** Writes `conversations.json` of about `bytes` bytes into `dir`, as one array on one line. */
export async function makeChatgptExport(dir: string, bytes: number): Promise<SyntheticExport> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, "conversations.json");
  const template = conversationTemplate();
  const out = createWriteStream(path);
  let written = 0;
  let count = 0;
  const write = async (text: string): Promise<void> => {
    written += Buffer.byteLength(text);
    if (!out.write(text)) await once(out, "drain");
  };
  await write("[");
  while (written < bytes) {
    const id = `synthetic-${count.toString(36).padStart(7, "0")}`;
    await write((count === 0 ? "" : ",") + template.replaceAll("__ID__", id));
    count++;
  }
  await write("]");
  out.end();
  await once(out, "finish");
  return { path, bytes: written, conversations: count };
}
