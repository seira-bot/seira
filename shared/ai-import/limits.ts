const MB = 1024 * 1024;
const GB = 1024 * MB;

export const AI_IMPORT_LIMITS = {
  uploadBytes: 8 * GB,
  extractedBytes: 16 * GB,
  entries: 200_000,
  jsonMemberBytes: 2 * GB,
  otherMemberBytes: 64 * MB,
  compressionRatio: 100,
  messageTextBytes: 16 * MB,
  jsonDepth: 64,
  pasteChars: 100_000,
  personaBytes: 24_000,
  chatBatchMessages: 500,
  undoDays: 7,
  workerMemoryMb: 512,
  sniffMs: 1_000,
  locateMs: 2_000,
} as const;
