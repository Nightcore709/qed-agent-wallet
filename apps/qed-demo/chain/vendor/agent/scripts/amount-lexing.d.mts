export declare function hasUnsafeSignedAmount(text: string): boolean;
export declare function scanAmount(text: string):
  | { kind: 'valid'; raw: bigint; text: string }
  | { kind: 'none' | 'invalid' | 'ambiguous'; reason: string };

export declare function formatMicro(raw: bigint | string | number): string;
