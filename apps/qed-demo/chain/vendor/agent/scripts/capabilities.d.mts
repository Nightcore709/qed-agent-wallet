export const CAPABILITIES: Record<string, { label: string; mode: string; schema: any }>;
export const MODEL_TOOLS: any[];
export function validateCapability(name: string, input: unknown): any;
export function describeCapability(name: string, input: unknown): string;
