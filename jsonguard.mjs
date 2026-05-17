/**
 * @module jsonguard (ESM entry point)
 * @version 1.4.1
 * @description ES Module wrapper for JSONGuard.
 *
 * Works in both Node.js and bundler environments (Vite, webpack, etc.).
 * For direct browser usage without a bundler, import jsonguard.js as a
 * script tag and access the global `jsonguard` function.
 *
 * @example
 *   import jsonguard from 'shrimp-jsonguard';
 *   import { extractJSON, repairJSON } from 'shrimp-jsonguard';
 *
 * @license MIT
 */

// ── Node.js ESM: use createRequire to load the CJS module ──
// ── Bundlers: will resolve the CJS entry via package.json "main" ──

let mod;

// Detect Node.js environment (has `process.versions.node`)
const isNode = typeof process !== 'undefined' &&
               process.versions != null &&
               process.versions.node != null;

if (isNode) {
  // Dynamic import of createRequire — works in Node.js ESM
  const { createRequire } = await import('module');
  const require = createRequire(import.meta.url);
  mod = require('./jsonguard.js');
} else {
  // Fallback for bundlers — they'll resolve this statically
  mod = await import('./jsonguard.js');
  if (mod.default) mod = mod.default;
}

export default mod;
export const jsonguard       = mod.jsonguard   || mod;
export const extractJSON     = mod.extractJSON;
export const repairJSON      = mod.repairJSON;
export const MAX_INPUT_LENGTH = mod.MAX_INPUT_LENGTH;
