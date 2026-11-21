import { chatgptReader } from "./chatgpt.ts";
import { claudeAiReader } from "./claude-ai.ts";
import { claudeCodeReader } from "./claude-code.ts";
import { hermesReader } from "./hermes.ts";
import { openclawReader } from "./openclaw.ts";
import type { SourceReader } from "./reader.ts";

export const READERS: readonly SourceReader[] = [chatgptReader, claudeAiReader, hermesReader, openclawReader, claudeCodeReader];
