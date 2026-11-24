/**
 * Refusal reasons for a person. A co-signer reason reads "<rule id> <the rule as it should hold>: <what was found>",
 * which on its own reads like a pass ("C12 Authority budget: this conversion's cost fits in what the owner granted"),
 * so it is said as the rule that did not hold (R7-111 walkthrough F6). The reasons themselves are kept as the
 * co-signer gave them, in the decision records.
 */
export const notMet = (reasons: string[]): string => reasons.map((r) => r.replace(/^([A-Z]+\d+) /, "$1 not met: ")).join("; ");
