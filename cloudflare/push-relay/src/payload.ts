import { z } from "zod";

import { sha256Hex } from "./common";
import { FCM_TTL } from "./push-fcm";

/** What one kind of notification looks like on the phone. The shipped phone apps created these ids. */
export interface KindPresentation {
  /** iOS notification category: the action buttons. */
  category: string;
  /** Android notification channel. */
  channel: string;
  /** iOS interruption level `time-sensitive` instead of `active`. */
  timeSensitive: boolean;
}

export const CATEGORY_APPROVAL = "OPENMAUS_APPROVAL";
export const CATEGORY_QUESTION = "OPENMAUS_QUESTION";
export const CATEGORY_UPDATE = "OPENMAUS_UPDATE";
export const CHANNEL_BLOCKING = "approval_question";
export const CHANNEL_MESSAGES = "bot_messages";
export const CHANNEL_ROUTINES = "routine_failed";

export const DEFAULT_PRESENTATION: KindPresentation = { category: CATEGORY_UPDATE, channel: CHANNEL_MESSAGES, timeSensitive: false };

export const KIND_PRESENTATION: ReadonlyMap<string, KindPresentation> = new Map<string, KindPresentation>([
  ["approval", { category: CATEGORY_APPROVAL, channel: CHANNEL_BLOCKING, timeSensitive: true }],
  ["question", { category: CATEGORY_QUESTION, channel: CHANNEL_BLOCKING, timeSensitive: true }],
  ["sign-in", { category: CATEGORY_UPDATE, channel: CHANNEL_BLOCKING, timeSensitive: true }],
  ["mention", { category: CATEGORY_UPDATE, channel: CHANNEL_MESSAGES, timeSensitive: true }],
  ["routine-failed", { category: CATEGORY_UPDATE, channel: CHANNEL_ROUTINES, timeSensitive: false }],
  ["routine-deferred", { category: CATEGORY_UPDATE, channel: CHANNEL_ROUTINES, timeSensitive: false }],
  ["routine-blocked", { category: CATEGORY_UPDATE, channel: CHANNEL_ROUTINES, timeSensitive: false }],
]);

export const presentationOf = (kind: string) => KIND_PRESENTATION.get(kind) ?? DEFAULT_PRESENTATION;

const TOKEN = /^[0-9a-f]{64,200}$/;
/** An FCM registration token: today `<instance id>:<token>`, about 160 characters; the format is Google's to change. */
const FCM_REGISTRATION = /^[A-Za-z0-9_:-]{64,4096}$/;
/** APNs takes at most 64 bytes. The phone uses the same string as its notification identifier. */
const COLLAPSE_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const ID = /^[\w-]{1,120}$/;
const KIND = /^[a-z][a-z-]{0,39}$/;
const PAIRING = /^[A-Za-z0-9_-]{8,64}$/;

function oneLine(max: number) {
  return z.string().min(1).max(max * 4).refine((value) => {
    if (value.trim() !== value || [...value].length > max) return false;
    return !/[\p{Cc}\u2028\u2029]/u.test(value);
  });
}

// The wire contract with the Seira server. Do not change these three schemas.
export const registerSchema = z.union([
  z.strictObject({
    v: z.literal(1),
    platform: z.literal("apns").optional(),
    purpose: z.enum(["alert", "activity", "activity-start"]).optional(),
    token: z.string().regex(TOKEN),
    environment: z.enum(["production", "sandbox"]),
  }),
  z.strictObject({
    v: z.literal(1),
    platform: z.literal("fcm"),
    token: z.string().regex(FCM_REGISTRATION),
    environment: z.literal("production").optional(),
  }),
]);
export const unregisterSchema = z.strictObject({
  v: z.literal(1),
  platform: z.enum(["apns", "fcm"]).optional(),
  token: z.string().regex(FCM_REGISTRATION),
});
export const sendSchema = z.strictObject({
  v: z.literal(1),
  token: z.string().regex(FCM_REGISTRATION),
  pairing: z.string().regex(PAIRING).optional(),
  collapseId: z.string().regex(COLLAPSE_ID).optional(),
  notification: z.strictObject({
    kind: z.string().regex(KIND),
    title: oneLine(200),
    botId: z.string().regex(ID),
    botName: oneLine(80),
    threadId: z.string().regex(ID),
    roomId: z.string().regex(ID).optional(),
    roomName: oneLine(80).optional(),
    requestId: z.string().regex(ID).optional(),
  }),
});
export type PushSendRequest = z.infer<typeof sendSchema>;

/** The keys the phone reads, the same for APNs and FCM. Never `botName`, `roomName`, or any text beyond the title. */
function routing(request: PushSendRequest) {
  const { notification } = request;
  return {
    kind: notification.kind,
    botId: notification.botId,
    threadId: notification.threadId,
    ...(request.pairing ? { pairing: request.pairing } : {}),
    ...(notification.roomId ? { roomId: notification.roomId } : {}),
    ...(notification.requestId ? { requestId: notification.requestId } : {}),
  };
}

/** Payload contract version 1, APNs: the routing keys sit beside `aps`, as in the app's notification `userInfo`. */
export function apnsPayload(request: PushSendRequest) {
  const { notification } = request;
  const presentation = presentationOf(notification.kind);
  return {
    aps: {
      alert: { title: notification.title },
      sound: "default",
      "thread-id": notification.threadId,
      category: presentation.category,
      "interruption-level": presentation.timeSensitive ? "time-sensitive" : "active",
    },
    v: 1,
    ...routing(request),
  };
}

/** Payload contract version 1, FCM: a data-only message. Every data value is a string. */
export function fcmPayload(request: PushSendRequest, token: string, collapseId: string) {
  const { notification } = request;
  return {
    message: {
      token,
      data: {
        v: "1",
        ...routing(request),
        title: notification.title,
        tag: collapseId,
        channelId: presentationOf(notification.kind).channel,
      },
      android: { priority: "HIGH", ttl: FCM_TTL },
    },
  };
}

export async function collapseIdOf(request: PushSendRequest): Promise<string> {
  return request.collapseId ?? (await sha256Hex(`${request.notification.kind}:${request.notification.threadId}`)).slice(0, 32);
}
