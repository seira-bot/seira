export type PhoneWireName = "pairingCredentialPrefix" | "linkScheme" | "environmentPath" | "healthApp" | "pushCollapsePrefix" | "mdnsServiceType" | "mdnsHostPrefix" | "sessionTokenPrefix";

export declare const PHONE_WIRE_NAMES: Readonly<Record<PhoneWireName, Readonly<{ legacy: string; seira: string }>>>;
export declare const PHONE_WIRE_SEND: "legacy" | "seira";
export declare function sentWireName(name: PhoneWireName): string;
export declare function acceptedWireNames(name: PhoneWireName): readonly [string, string];
export declare function acceptsWireName(name: PhoneWireName, value: string): boolean;
