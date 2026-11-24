export declare const TEXT_SIZE_STEPS: readonly number[];
export declare const DEFAULT_TEXT_SIZE: number;
export declare function isTextSize(value: unknown): boolean;
export declare function normalizeTextSize(value: unknown): number;
export declare function stepTextSize(current: unknown, direction: number): number;
export declare function textSizeMinimum(step: unknown, base: { width: number; height: number }, workArea?: { width: number; height: number } | null): { width: number; height: number };
