declare module "*/mascot/runtime/bot.js" {
  export interface SeiraBotOptions {
    bases: object;
    stickers: object;
    /** `true` stops the runtime clock: the caller moves time with `tick`. */
    manual?: boolean;
    /** `true` gives a still pose. Without it, the runtime reads `prefers-reduced-motion`. */
    reduced?: boolean;
    seed?: number;
  }

  export interface SeiraBot {
    readonly canvas: HTMLCanvasElement;
    setConfig(partial: { hairColor?: string | null; name?: string; style?: string; accessories?: readonly string[] }): Promise<void>;
    express(id: string, options?: { ms?: number }): void;
    play(id: string): Promise<void>;
    setState(id: string): void;
    tick(ms?: number): void;
    destroy(): void;
  }

  export function createBot(
    el: HTMLElement,
    config?: { name?: string; hairColor?: string | null; style?: string; accessories?: readonly string[] },
    options?: SeiraBotOptions,
  ): Promise<SeiraBot>;
}

declare module "*/mascot/runtime/catalog.js" {
  export const STATES: Record<string, object>;
  export const FACES: Record<string, object>;
  export const ACTIONS: Record<string, { ms: number }>;
}
