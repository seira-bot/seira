import { hostname, userInfo } from "node:os";

export function laptopLines(input: { port: number; user: string; host: string; prefix: string }): string[] {
  const { port, user, host, prefix } = input;
  return [
    `Laptop   ssh -L ${port}:127.0.0.1:${port} ${user}@${host}`,
    `           Keep it open on the laptop. Then run \`${prefix} pair\` here, and open its "Browser on this machine" link on the laptop.`,
  ];
}

export function laptopLinesHere(port: number, prefix: string): string[] {
  try {
    return laptopLines({ port, user: userInfo().username, host: hostname(), prefix });
  } catch {
    return [];
  }
}
