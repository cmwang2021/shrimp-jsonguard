/**
 * @module jsonguard (ESM entry point)
 * @version 1.4.0
 * @description ES Module wrapper for JSONGuard.
 *              Allows: import jsonguard from 'shrimp-jsonguard'
 *
 * @license MIT
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const mod = require('./jsonguard.js');

export default mod;
export const jsonguard   = mod.jsonguard;
export const extractJSON = mod.extractJSON;
export const repairJSON  = mod.repairJSON;
