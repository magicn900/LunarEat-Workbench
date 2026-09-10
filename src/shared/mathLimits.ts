export const mathPreviewLimits = { sourceLength: 12000, maxExpand: 1000, maxSize: 10, timeoutMs: 2000 } as const;
export type MathPreviewResult = { html?: string; error?: string };
