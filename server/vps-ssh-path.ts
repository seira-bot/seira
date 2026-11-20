// Where the ssh control sockets of one data path live. Apart from vps-ssh.ts so that the test setup can name the folder without loading it.
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

export const VPS_SSH_DIR = "ssh";

/**
 * macOS caps Unix socket paths at 104 bytes and OpenSSH appends a temporary suffix, so a long data path cannot host the socket.
 * The shared folder is the same for every run of one data path: a master that outlives Seira is found again, so it stays.
 * Returns null where the data path is short enough to host the sockets itself, and on a host without user ids (Windows).
 */
export function vpsSshSharedControlDirectory(sshDir: string): string | null {
  const uid = process.getuid?.();
  if (uid === undefined || Buffer.byteLength(join(sshDir, `cm-${"0".repeat(40)}`)) <= 80) return null;
  const id = createHash("sha256").update(resolve(sshDir)).digest("hex").slice(0, 12);
  // /tmp, not tmpdir(): macOS TMPDIR is often too long for a control socket.
  return `/tmp/seira-ssh-${uid}-${id}`;
}
