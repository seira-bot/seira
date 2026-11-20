const GROUP = /^[0-9a-f]{1,4}$/i;
const OCTET = /^\d{1,3}$/;

/** The eight 16-bit groups of an IPv6 address, or null when the text is not one. */
function ipv6Groups(address: string): number[] | null {
  const text = address.split("%")[0]!;
  if (!text.includes(":") || text.length > 45) return null;

  const parts = text.split(":");
  const last = parts[parts.length - 1]!;
  if (last.includes(".")) {
    const octets = last.split(".");
    if (octets.length !== 4 || !octets.every((octet) => OCTET.test(octet) && Number(octet) <= 255)) return null;
    const [a, b, c, d] = octets.map(Number) as [number, number, number, number];
    parts.splice(-1, 1, ((a << 8) | b).toString(16), ((c << 8) | d).toString(16));
  }

  const halves = parts.join(":").split("::");
  if (halves.length > 2) return null;
  const groupsOf = (half: string) => (half === "" ? [] : half.split(":"));
  const head = groupsOf(halves[0]!);
  const tail = halves.length === 2 ? groupsOf(halves[1]!) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;

  const groups = [...head, ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => "0"), ...tail];
  if (!groups.every((group) => GROUP.test(group))) return null;
  return groups.map((group) => Number.parseInt(group, 16));
}

/**
 * The key of the per-address limits for the text of `cf-connecting-ip`.
 * An IPv4 address is its own key. An IPv6 address maps to its /64 prefix, because one subscriber
 * holds a whole /64 and can use any address in it. An IPv4-mapped IPv6 address maps to its IPv4 address.
 * Text that is not an IP address is its own key.
 */
export function rateKeyOf(address: string): string {
  const groups = ipv6Groups(address);
  if (!groups) return address;
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return `${groups[6]! >> 8}.${groups[6]! & 255}.${groups[7]! >> 8}.${groups[7]! & 255}`;
  }
  return `${groups.slice(0, 4).map((group) => group.toString(16)).join(":")}::/64`;
}
