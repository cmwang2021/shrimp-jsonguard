/**
 * Deterministic JSON repair engine for LLM output.
 * Zero dependencies. Handles truncation, trailing commas, single quotes,
 * unquoted keys, illegal values, Markdown fences, and more.
 */

/**
 * Diagnostic object returned when repair fails.
 */
export interface RepairFailure {
  error: string;
  raw: string;
  diag: string;
}

/**
 * Repair and parse broken JSON produced by LLMs.
 *
 * Returns the parsed JavaScript value on success, or a `RepairFailure`
 * diagnostic object on failure.
 *
 * @param input  Raw LLM output string.
 */
declare function jsonguard(input: string): any | RepairFailure;

/**
 * Phase 0 — Strip Markdown fences, JS comments, surrounding prose,
 * and isolate the JSON payload.
 *
 * @param input  Raw LLM output.
 * @returns      Cleaned payload string ready for structural repair.
 */
export declare function extractJSON(input: string): string;

/**
 * Phase 1 — Walk the payload character by character and apply
 * deterministic structural repairs.
 *
 * @param s  Cleaned payload from extractJSON.
 * @returns  Structurally repaired JSON string (not yet parsed).
 */
export declare function repairJSON(s: string): string;

/**
 * Maximum input length in characters (default: 5 MB).
 * Inputs exceeding this limit return an error immediately.
 */
export declare var MAX_INPUT_LENGTH: number;

export default jsonguard;
export { jsonguard };
