/** One thing the app offers, in the words the person sees. A bot reads this catalog (app_settings action=features)
 * to answer where something is and what it does, so a page, tab, agent tool, slash command or release note with
 * no entry is a gap the drift test reports. */
export interface AppFeature {
  id: string;
  /** The product word the person sees. */
  name: string;
  /** Where the person finds it; never a menu path that does not exist. */
  place: string;
  /** What it is and how it differs from the feature next to it, in at most 240 characters. */
  does: string;
  /** Agent tools a bot calls for this feature. */
  tools?: readonly string[];
  /** Release note item ids that announce this feature. */
  releaseNotes?: readonly string[];
  /** Built-in slash commands of the composer. */
  slashCommands?: readonly string[];
  /** Views of the Automations page. */
  automationViews?: readonly string[];
  /** Kinds of row in the @ list of the chat box. */
  mentionRows?: readonly string[];
}

export const APP_FEATURE_DOES_MAX = 240;

/** Agent tools that no person sees or asks about by name. */
export const INTERNAL_AGENT_TOOLS: ReadonlySet<string> = new Set(["tool_result_read"]);

export const APP_FEATURES: readonly AppFeature[] = [
  {
    id: "automations",
    name: "Automations",
    place: "Automations in the sidebar: the List and Calendar views of routines",
    does: "Routines decide when a bot works: on a schedule, on an app event, or on a webhook call. A routine can also run a workflow. It is not the steps of the work; those belong to a workflow.",
    tools: ["trigger_info", "trigger", "delete_trigger"],
    automationViews: ["list", "calendar"],
  },
  {
    id: "workflows",
    name: "Workflows",
    place: "Automations → Workflows",
    does: "Steps that bots take in order, saved on a canvas. It runs only when a routine uses it. Make one with New workflow, Draw a workflow instead, or Draw as workflow on a reply. A bot can read, make and link workflows.",
    tools: ["workflow"],
    releaseNotes: ["workflows", "drawFromReply", "botWorkflows"],
    automationViews: ["workflows"],
  },
  {
    id: "waits",
    name: "Waits",
    place: "in the chat where the bot set the wait",
    does: "A bot tells the person in one chat when something happens, such as a page change or a time. No AI runs while it waits. A wait ends once; a routine repeats.",
    tools: ["wait_until", "list_waits", "cancel_wait"],
  },
  {
    id: "slash-menu",
    name: "The / list",
    place: "the chat box: type /",
    does: "Lists the skills of the bot and the built-in commands: /goal, /learn, /setup and /burst. A skill runs for one message when its name follows the slash.",
    slashCommands: ["goal", "learn", "setup", "burst"],
    tools: ["burst"],
  },
  {
    id: "mention-menu",
    name: "The @ list",
    place: "the chat box: type @",
    does: "Lists other bots, the connected apps and MCP servers this bot can use, teammates, and @devs. In a direct chat, tagging an app or a server asks the bot to use it for that message.",
    mentionRows: ["agent", "app", "mcp", "person", "team", "channel", "devs"],
    releaseNotes: ["appsInChat"],
  },
  {
    id: "bots",
    name: "Bots and teams",
    place: "the Bots list in the sidebar; New bot",
    does: "Each bot has its own name, instructions, model and folder. A Chief of Staff adds specialists and sets up teams. A department groups bots.",
    tools: ["list_bots", "create_bot", "list_team_setup", "list_team_library", "propose_team_setup", "propose_bot_deletion", "suggest_team", "propose_profile", "propose_team_memory", "share"],
    releaseNotes: ["sendSetting", "teamSuggestion"],
  },
  {
    id: "handoffs",
    name: "Threads and handoffs",
    place: "Bot threads in the sidebar",
    does: "A bot can hand work to another bot, open a separate thread on itself, or run parts of one job in parallel. Each thread has its own history and shows in the sidebar.",
    tools: ["coordinate_bots", "assignment_status", "retry_thread", "list_room_targets", "start_thread", "list_threads", "close_thread", "rename_thread", "post_to_thread", "burst"],
  },
  {
    id: "rooms",
    name: "Group chats",
    place: "Group chats in the sidebar",
    does: "A shared chat where several bots and people talk together. A bot can post to a group chat it belongs to.",
    tools: ["list_rooms", "post_to_room", "manage_room"],
  },
  {
    id: "chats",
    name: "Chats",
    place: "a conversation with a bot",
    does: "Replies show code with a copy control, and an activity card with the tools the bot used. Long chats open at the newest messages and load older ones when the person scrolls up.",
    releaseNotes: ["copyCode", "longChats", "turnActivity"],
  },
  {
    id: "skills",
    name: "Skills",
    place: "Settings → You and your bots → Skills",
    does: "A skill is a SKILL.md that tells a bot how to do one kind of work. A bot can write its own, or import one from GitHub. Built-in skills load by keyword; a skill the person adds belongs to one bot.",
    tools: ["skills_list", "skill_manage"],
  },
  {
    id: "mcp-servers",
    name: "MCP servers",
    place: "Apps → MCP servers",
    does: "Tool servers the person adds to give bots more abilities. They are separate from Connected apps such as Gmail, which the person signs in to. Tag one with @ in a direct chat.",
    tools: ["mcp_server"],
  },
  {
    id: "connected-apps",
    name: "Connected apps",
    place: "Apps → Connected apps",
    does: "Accounts such as Gmail, Calendar, Slack or Notion that the person connects so bots can use them. Select Connect on an app, then sign in with the link Seira gives. Tag one with @ in a direct chat.",
    releaseNotes: ["connectOneClick", "appsConnected", "socialRepliz"],
  },
  {
    id: "settings",
    name: "Settings",
    place: "the menu under the person's name at the bottom of the sidebar",
    does: "Appearance, language, defaults for new bots, AI engines and keys. A bot reads and changes safe settings itself; the person changes the rest.",
    tools: ["app_settings"],
  },
  {
    id: "ai-engines",
    name: "AI engines",
    place: "Settings → AI",
    does: "The AIs that bots use, by plan or by key. The person can spread work across several AIs. Each Claude account keeps its own approvals. The Flatpak app finds engines the host installs.",
    releaseNotes: ["aiPool", "claudeAccounts", "flatpakEngine"],
  },
  {
    id: "models",
    name: "Models and usage",
    place: "the model choice of a bot; Settings → AI; the usage ring at the bottom of the sidebar",
    does: "A bot runs on one engine and model. A bot can read the model choices and each AI account's usage limits, and can ask to switch its own model. A ring in the sidebar shows how much of the AI plan is left.",
    tools: ["list_models", "propose_model", "usage_limits"],
    releaseNotes: ["usageRing"],
  },
  {
    id: "profile",
    name: "Your profile",
    place: "Settings → You and your bots → About you",
    does: "The person's name, photo and look. A new person gets a random look, and Shuffle gives another.",
    releaseNotes: ["personLook"],
  },
  {
    id: "phone-push",
    name: "Alerts when the phone app is closed",
    place: "Settings → Phone & devices → Alerts when the phone app is closed",
    does: "Wakes the closed phone app for approvals, questions, sign-ins and finished replies. Off until the person turns it on. The alert holds names and the kind of alert, never the message.",
    releaseNotes: ["phonePush"],
  },
  {
    id: "computers",
    name: "Computers",
    place: "the Computer tab of a bot's panel",
    does: "Where a bot works with a screen, a browser or files: this computer, a Cloud desktop, a shared desktop or its own Local VM.",
    tools: ["select_computer", "list_shared_computers", "shared_computer", "vm_exec", "ask_for_computer", "reset_cloud_computer"],
  },
  {
    id: "pages-apps",
    name: "Pages and apps",
    place: "Published apps in the sidebar",
    does: "A page or a small app that a bot made and put online at a link. Publishing needs the person's request. Hosting of apps is part of a Cloud plan.",
    tools: ["publish_page", "unpublish_page", "publish_app", "check_app_hosting"],
  },
  {
    id: "widgets",
    name: "Widgets",
    place: "in the chat itself",
    does: "A small interactive piece that a bot shows in a chat: a tap-to-answer question, or a small web page the person can point at to change.",
    tools: ["show_widget", "show_html", "create_options_card"],
  },
  {
    id: "files",
    name: "Files",
    place: "Files in the sidebar",
    does: "A bot attaches a finished file to the chat so the person can preview and download it.",
    tools: ["attach_file"],
  },
  {
    id: "secrets",
    name: "Credentials and sign-in",
    place: "a secure card in the chat",
    does: "A bot asks for a secret on a secure card, never in the chat. It can ask the person to sign in to a site, or use a saved login.",
    tools: ["request_credential", "request_sign_in", "fill_login"],
  },
  {
    id: "memory",
    name: "Memory",
    place: "the Memory section of the bot's own settings (click the bot's name at the top of its chat)",
    does: "What a bot remembers between tasks: a long-term memory file, a daily log, and search of its earlier chats.",
    tools: ["memory_update", "memory_log", "session_search"],
  },
  {
    id: "research",
    name: "Research and extraction",
    place: "in the chat; the person turns research on in the bot's settings",
    does: "A bot can read X posts, look up companies and people through paid research calls, pull typed values from text or an image, and ask a decision model typed questions.",
    tools: ["x_search", "research_search", "research_endpoint", "research_call", "decide", "extract"],
  },
  {
    id: "images-voice",
    name: "Images and voice",
    place: "in the chat",
    does: "A bot can make an image, change an existing image from an instruction, or send a spoken voice note.",
    tools: ["generate_image", "edit_image", "send_voice_note"],
  },
  {
    id: "meetings",
    name: "Meetings",
    place: "in the chat; the bot joins a call from its link",
    does: "A bot joins a video call, posts in its chat, and writes the notes. It needs a Cloud computer. A Live call is different: it is a spoken call with the bot itself.",
    tools: ["join_meeting", "meeting_status", "post_in_meeting_chat", "leave_meeting", "post_meeting_notes"],
  },
  {
    id: "live-calls",
    name: "Live calls",
    place: "a Live call in a chat",
    does: "A spoken call with a bot. A spoken yes approves a command only after the bot says all of it, flags included.",
    releaseNotes: ["liveYes"],
  },
  {
    id: "board",
    name: "Board",
    place: "Board in the sidebar, above Automations",
    does: "Shows every piece of work your bots have, in To do, Working, Needs you and Done. Open a card to answer, stop the work or open its conversation, or add a new task.",
    releaseNotes: ["board"],
  },
  {
    id: "inbox",
    name: "Inbox",
    place: "Your inbox under People in the sidebar",
    does: "Where a bot leaves news for the person, or a message for a teammate, when it should not wait in a chat.",
    tools: ["message_person", "list_unread_notifications", "mark_notifications_read"],
  },
  {
    id: "bug-reports",
    name: "Bug reports",
    place: "under the reply that hit an error",
    does: "When Seira hits an error of its own, a draft report waits under the reply. It goes to the Seira team only when the person selects Send report.",
    tools: ["report_bug"],
    releaseNotes: ["bugReport"],
  },
  {
    id: "ai-import",
    name: "Move from another AI",
    place: "Settings → Import & export → Bring things in → Move from another AI",
    does: "Brings the persona, memories, skills, tools, routines and chats of ChatGPT, Claude.ai, Claude Code, Hermes or OpenClaw into Seira. The person reviews what Seira found before anything comes in.",
    releaseNotes: ["aiImport"],
  },
  {
    id: "backups",
    name: "Backups",
    place: "Settings → Import & export → Take things out → Export full backup",
    does: "A full backup of chats, bots and settings. Backup files end in .seirabackup, and older backup files still open.",
    releaseNotes: ["backupName"],
  },
  {
    id: "whats-new",
    name: "What's new",
    place: "the menu under the person's name at the bottom of the sidebar",
    does: "After an update, a short note says what changed. The person sees it once.",
    releaseNotes: ["whatsNew"],
  },
  {
    id: "app",
    name: "The Seira app",
    place: "the whole app",
    does: "The app is named Seira everywhere. Chats, bots and settings carry over from earlier names. The window shows right away at start.",
    releaseNotes: ["seiraName", "fasterStart", "linuxDesktop"],
  },
];

const FILLER = new Set(["seira", "the", "and", "for", "how", "what", "where", "does", "do", "is", "are", "my", "in", "of", "to", "me", "can", "you", "about", "mean", "meant"]);

function words(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 1 && !FILLER.has(word)).map((word) => (word.length > 3 ? word.replace(/s$/, "") : word)))];
}

function score(feature: AppFeature, query: string, queryWords: readonly string[]): number {
  const name = feature.name.toLowerCase();
  const place = feature.place.toLowerCase();
  const does = feature.does.toLowerCase();
  const tools = (feature.tools ?? []).join(" ");
  let total = name.includes(query) || feature.id === query ? 10 : 0;
  for (const word of queryWords) {
    if (name.includes(word) || feature.id.includes(word)) total += 5;
    if (place.includes(word)) total += 3;
    if (tools.includes(word)) total += 2;
    if (does.includes(word)) total += 1;
  }
  return total;
}

/** The features that best match `query`, highest score first, at most `limit`. With no usable words it returns every
 * feature in catalog order, so a bot can read the whole list. */
export function findAppFeatures(query: string, limit = 5): AppFeature[] {
  const queryWords = words(query);
  if (!queryWords.length) return [...APP_FEATURES];
  const phrase = queryWords.join(" ");
  return APP_FEATURES.map((feature) => ({ feature, score: score(feature, phrase, queryWords) }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((hit) => hit.feature);
}

