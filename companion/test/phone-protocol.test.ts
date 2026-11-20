import { describe, expectTypeOf, it } from "vitest";

import type { Notification, NotificationLogEntry } from "../../packages/phone-protocol/src/notification.ts";
import type { PhonePushData, PhonePushNotification } from "../../packages/phone-protocol/src/phone-push.ts";
import type { CompanionEndpointsSnapshot, PairResponse, ServerFrame } from "../../packages/phone-protocol/src/wire.ts";
import type { PairingErrorCode } from "../../packages/phone-protocol/src/pairing-code.ts";
import type { PairingRefusal, PublicDevice } from "../src/devices.ts";
import type { E2EDescriptor } from "../src/e2e/descriptor.ts";
import type { CompanionEndpoint } from "../src/endpoints.ts";
import type { CompanionEndpointSnapshot } from "../src/proxy.ts";

describe("the phone protocol's types", () => {
  it("cover what the companion sends a phone", () => {
    type Endpoints = CompanionEndpointSnapshot & { version?: string; e2e?: E2EDescriptor };
    expectTypeOf<Endpoints>().toExtend<CompanionEndpointsSnapshot>();
    expectTypeOf<{ kind: "companion.endpoints" } & Endpoints>().toExtend<ServerFrame>();
    type Paired = { device: PublicDevice; token: string } & { serverName: string; hosts?: string[]; endpoints?: CompanionEndpoint[]; e2e?: E2EDescriptor };
    expectTypeOf<Paired>().toExtend<PairResponse>();
    expectTypeOf<PairingRefusal["code"]>().toExtend<PairingErrorCode>();
  });

  it("name the request a notification waits on without breaking a phone that does not know it", () => {
    expectTypeOf<NonNullable<Notification["requestId"]>>().toEqualTypeOf<string>();
    expectTypeOf<Omit<Notification, "requestId">>().toExtend<Notification>();
    expectTypeOf<{ kind: "notify"; notification: Omit<NotificationLogEntry, "requestId"> }>().toExtend<ServerFrame>();
    expectTypeOf<NonNullable<PhonePushNotification["requestId"]>>().toEqualTypeOf<string>();
    expectTypeOf<NonNullable<PhonePushData["requestId"]>>().toEqualTypeOf<string>();
    expectTypeOf<Omit<PhonePushNotification, "requestId">>().toExtend<PhonePushNotification>();
  });
});
