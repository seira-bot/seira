import { randomUUID } from "node:crypto";

export interface TicketInput {
  caller: string;
  profileId: string;
  /** Site to the raw host keys that make it up. */
  sites: ReadonlyMap<string, readonly string[]>;
}

export interface Ticket extends TicketInput { expiresAt: number }

export interface TicketStore {
  issue(input: TicketInput): string;
  /** A ticket works once, for the caller it was issued to, within its lifetime. */
  take(id: string, caller: string): Ticket | null;
}

const LIFETIME_MS = 5 * 60 * 1000;
const MAX_OPEN = 50;

export function createTicketStore(now: () => number = Date.now): TicketStore {
  const open = new Map<string, Ticket>();
  const sweep = () => { for (const [id, ticket] of open) if (ticket.expiresAt <= now()) open.delete(id); };
  return {
    issue(input) {
      sweep();
      while (open.size >= MAX_OPEN) open.delete(open.keys().next().value!);
      const id = randomUUID();
      open.set(id, { ...input, expiresAt: now() + LIFETIME_MS });
      return id;
    },
    take(id, caller) {
      const ticket = open.get(id);
      if (!ticket) return null;
      if (ticket.expiresAt <= now()) { open.delete(id); return null; }
      if (ticket.caller !== caller) return null;
      open.delete(id);
      return ticket;
    },
  };
}
