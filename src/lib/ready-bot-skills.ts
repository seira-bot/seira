import type { BotSkillTemplate } from "../../shared/new-bot-defaults";

export const skillSecureCodeGuidance: BotSkillTemplate = {
  name: "secure-code-guidance",
  description: "Identify security weaknesses and advise safe patterns across auth, data validation, crypto, and network calls.",
  source: "seira",
  text: `---
name: secure-code-guidance
description: Review or write Python, JavaScript, TypeScript, or Go code using secure defaults. Use only for explicit security guidance, security reviews, or secure implementation requests, not ordinary code review.
---

# Secure Code Guidance

Ground reviews and implementation advice in secure engineering practices:
- Identify concrete security issues supported by code evidence.
- Pay attention to authorization, validation of untrusted input, injection risks, secret handling, and safe network calls.
- Suggest minimal, practical remediations that preserve intended behavior.
`,
  enabled: true,
  warnings: [],
};

export const skillHumanizer: BotSkillTemplate = {
  name: "humanizer",
  description: "Rewrite drafts so they sound natural and human, removing AI cliché and robotic phrasing.",
  source: "seira",
  text: `---
name: humanizer
description: Rewrite drafts so they sound natural and human, removing AI cliché and robotic phrasing.
---

# Humanizer

Rewrite drafts so they read like a person wrote them in the user's voice:
- Keep the original facts, numbers, and meaning intact.
- Remove robotic AI clichés, filler phrases, and excessive hedging.
- Vary sentence lengths naturally and prefer concrete language over vague buzzwords.
`,
  enabled: true,
  warnings: [],
};
