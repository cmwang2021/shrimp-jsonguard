/**
 * @module jsonguard
 * @version 1.4.2
 * @description Deterministic JSON repair engine for LLM output.
 *
 * Implements a three-phase repair pipeline:
 *   Phase 0  — Extract: strips Markdown fences, JS comments, JSONP wrappers,
 *              and leading/trailing prose to isolate the JSON payload.
 *   Phase 1  — Repair: walks the payload character-by-character using a
 *              lightweight state machine, applying 12 targeted repair
 *              strategies for the most common LLM failure modes.
 *   Phase 2  — Parse: validates the repaired string with JSON.parse().
 *              Returns the parsed value on success, or a diagnostic object
 *              on failure so downstream code never throws unexpectedly.
 *
 * Design principles:
 *   • Zero external dependencies — copy this single file into any project.
 *   • Deterministic — the same input always produces the same output.
 *   • Non-destructive — valid JSON passes through untouched.
 *   • Defence-in-depth — regex for *text cleanup*, state machine for
 *     *structural repair*.  Never the other way around.
 *   • Safe-by-default — MAX_INPUT_LENGTH and MAX_NESTING_DEPTH guards
 *     prevent denial-of-service on untrusted input.
 *
 * Performance:
 *   • O(n) time complexity — single-pass state machine, no backtracking.
 *   • Array-buffered output — avoids O(n²) string concatenation.
 *   • Input size guard — rejects payloads exceeding MAX_INPUT_LENGTH
 *     to prevent denial-of-service on untrusted input.
 *
 * @example
 *   const jsonguard = require('./jsonguard');
 *   const obj = jsonguard('```json\n{"name": "Shrimp Clan", "status": "Hero",');
 *   // => { name: 'Shrimp Clan', status: 'Hero' }
 *
 * @license MIT
 * @see https://github.com/cmwang2021/shrimp-jsonguard
 *
 * Built with ❤️ by Shrimp Clan (蝦家班). Part of the "One Dollar Project".
 */

'use strict';

// ─────────────────────────────────────────────────────────
//  Configuration
// ─────────────────────────────────────────────────────────

/**
 * Maximum input length in characters.  Inputs exceeding this limit are
 * rejected immediately to guard against accidental or malicious DoS.
 * Override via `jsonguard.MAX_INPUT_LENGTH = <number>`.
 *
 * @type {number}
 */
var MAX_INPUT_LENGTH = 5 * 1024 * 1024; // 5 MB

/**
 * Maximum nesting depth for JSON structures.  If the repair engine
 * encounters nesting deeper than this limit, it stops opening new
 * containers to prevent stack overflow from adversarial input.
 * Override via `jsonguard.MAX_NESTING_DEPTH = <number>`.
 *
 * @type {number}
 */
var MAX_NESTING_DEPTH = 512;

// ─────────────────────────────────────────────────────────
//  Phase 0 — Extract: isolate the JSON payload from noise
// ─────────────────────────────────────────────────────────

/**
 * Strip Markdown code-fence delimiters (case-insensitive).
 * Handles ```json, ```JSON, ```js, ```javascript, and bare ```.
 *
 * @param {string} s
 * @returns {string}
 */
function stripMarkdownFences(s) {
  // Opening fences: ```json / ```JSON / ```js / ```javascript / bare ```
  s = s.replace(/```(?:json|JSON|js|javascript)?\s*\n?/g, '');
  return s;
}

/**
 * Remove JavaScript-style comments that live *outside* of JSON strings.
 * We use a small state tracker so that `//` inside `"url: //example"` is
 * left intact.
 *
 * Uses Array buffer for O(n) output assembly.
 *
 * @param {string} s
 * @returns {string}
 */
function stripComments(s) {
  var buf = [];
  var inStr = false;
  var esc = false;
  var i = 0;
  var len = s.length;

  while (i < len) {
    var ch = s[i];

    // ── inside a JSON string ──
    if (inStr) {
      buf.push(ch);
      if (esc)        { esc = false; }
      else if (ch === '\\') { esc = true; }
      else if (ch === '"')  { inStr = false; }
      i++;
      continue;
    }

    // ── outside a string ──
    if (ch === '"') {
      inStr = true;
      buf.push(ch);
      i++;
      continue;
    }

    // Line comment //
    if (ch === '/' && i + 1 < len && s[i + 1] === '/') {
      // Skip until end of line
      i += 2;
      while (i < len && s[i] !== '\n') { i++; }
      continue;
    }

    // Block comment /* ... */
    if (ch === '/' && i + 1 < len && s[i + 1] === '*') {
      i += 2;
      while (i < len && !(s[i] === '*' && i + 1 < len && s[i + 1] === '/')) { i++; }
      i += 2; // skip closing */
      continue;
    }

    buf.push(ch);
    i++;
  }

  return buf.join('');
}

/**
 * Locate the outermost JSON structure within a larger string.
 * Finds the first `{` or `[` and the last matching `}` or `]`,
 * discarding any surrounding prose such as "Here is the JSON:".
 *
 * Handles truncated inputs correctly by counting bracket depth — if the
 * outermost structure is never closed, keeps everything to EOF.
 *
 * @param {string} s  Pre-cleaned string (fences and comments removed).
 * @returns {string}   The extracted substring, or the original if no
 *                     structural characters are found.
 */
function extractPayload(s) {
  // Find the first structural opening character
  var firstBrace   = s.indexOf('{');
  var firstBracket = s.indexOf('[');

  var start = -1;
  if (firstBrace === -1 && firstBracket === -1) { return s.trim(); }
  if (firstBrace === -1)        { start = firstBracket; }
  else if (firstBracket === -1) { start = firstBrace; }
  else                          { start = Math.min(firstBrace, firstBracket); }

  // Find the last structural closing character
  var lastBrace   = s.lastIndexOf('}');
  var lastBracket = s.lastIndexOf(']');
  var end = Math.max(lastBrace, lastBracket);

  if (end === -1 || end < start) { end = s.length - 1; }

  // Guard against truncated inputs:  if the outermost structure is never
  // closed (bracket depth never returns to zero), the last } or ] belongs
  // to an *inner* structure.  In that case, keep everything to EOF and let
  // the repair engine handle closure.
  var depth = 0;
  var inString = false;
  var escaped = false;
  for (var k = start; k <= end; k++) {
    var c = s[k];
    if (inString) {
      if (escaped)            { escaped = false; }
      else if (c === '\\')    { escaped = true; }
      else if (c === '"')     { inString = false; }
      continue;
    }
    if (c === '"')            { inString = true; continue; }
    if (c === '{' || c === '[') { depth++; }
    if (c === '}' || c === ']') { depth--; }
  }

  // depth > 0 means the input is truncated — extend to the full string
  if (depth > 0) { end = s.length - 1; }

  return s.substring(start, end + 1);
}

/**
 * Phase 0 entry point.  Strips noise and isolates the JSON payload.
 *
 * @param {string} input  Raw LLM output.
 * @returns {string}      Cleaned payload ready for structural repair.
 */
function extractJSON(input) {
  if (typeof input !== 'string') { return ''; }
  var s = input;

  // Strip BOM (Byte Order Mark) — Windows Notepad and some editors prepend
  // \uFEFF to UTF-8 files, which breaks JSON.parse().
  if (s.charCodeAt(0) === 0xFEFF) { s = s.substring(1); }

  // Strip NUL bytes (\u0000) — some LLMs emit null characters in their
  // output stream, which are invisible but fatal to JSON.parse().
  if (s.indexOf('\u0000') !== -1) { s = s.replace(/\u0000/g, ''); }

  s = stripMarkdownFences(s);
  s = stripComments(s);
  s = extractPayload(s);
  return s.trim();
}

// ─────────────────────────────────────────────────────────
//  Phase 1 — Repair: deterministic state-machine engine
// ─────────────────────────────────────────────────────────

/** Tokens that represent JSON literal values the LLM may emit illegally. */
var ILLEGAL_LITERALS = {
  'NaN':       'null',
  'nan':       'null',
  'Infinity':  'null',
  'infinity':  'null',
  '-Infinity': 'null',
  '-infinity': 'null',
  'undefined': 'null',
  'None':      'null',   // Python-style
  'True':      'true',   // Python-style
  'False':     'false',  // Python-style
};

/**
 * Return `true` if `ch` is a character that can start an unquoted key
 * (letter, underscore, dollar sign).
 */
function isKeyStart(ch) {
  return /[a-zA-Z_$]/.test(ch);
}

/**
 * Return `true` if `ch` can continue an unquoted key.
 * Includes hyphen (-) and dot (.) to support kebab-case and dotted keys
 * commonly seen in JSON5 / JS-style objects.
 */
function isKeyChar(ch) {
  return /[a-zA-Z0-9_$\-.]/.test(ch);
}

/**
 * Attempt to match one of the ILLEGAL_LITERALS tokens at position `i`
 * in the string `s`.  Returns the matched token or `null`.
 */
function matchIllegalLiteral(s, i) {
  // Try longest candidates first to avoid partial matches.
  var candidates = ['-Infinity', '-infinity', 'Infinity', 'infinity',
                    'undefined', 'False', 'True', 'None', 'NaN', 'nan'];
  for (var c = 0; c < candidates.length; c++) {
    var token = candidates[c];
    if (s.substring(i, i + token.length) === token) {
      // Make sure the next character is not alphanumeric (word boundary).
      var next = s[i + token.length];
      if (!next || !/[a-zA-Z0-9_$]/.test(next)) {
        return token;
      }
    }
  }
  return null;
}

/**
 * Find the last significant (non-whitespace) character in a buffer array.
 *
 * @param {string[]} buf  The output buffer.
 * @returns {string}      The last non-whitespace character, or ''.
 */
function lastSignificant(buf) {
  for (var j = buf.length - 1; j >= 0; j--) {
    var c = buf[j];
    if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') {
      return c;
    }
  }
  return '';
}

/**
 * Phase 1 — Walk the extracted payload character by character and emit
 * a repaired JSON string.
 *
 * The algorithm maintains a tiny state machine:
 *   • `stack`  — tracks open containers ("{" for object, "[" for array).
 *   • `inStr`  — whether the cursor is inside a JSON string.
 *   • `esc`    — whether the previous character was a backslash.
 *
 * At each position the engine asks "does the next token violate JSON
 * grammar?" and, if so, applies the minimal fix.
 *
 * Output is assembled in an Array buffer and joined once at the end,
 * giving O(n) performance instead of O(n²) from string concatenation.
 *
 * @param {string} s  Cleaned payload from Phase 0.
 * @returns {string}  Structurally repaired JSON string.
 */
function repairJSON(s) {
  if (!s || s.length === 0) { return '""'; }

  var buf = [];        // output buffer — joined once at the end
  var stack = [];      // container stack: '{' | '['
  var inStr = false;
  var esc = false;
  var i = 0;
  var len = s.length;

  // ── Helper: peek at the current container type ──
  function top() { return stack.length ? stack[stack.length - 1] : null; }

  // ── Helper: skip whitespace, return next non-ws char (or '') ──
  function peekNonWS(from) {
    for (var j = from; j < len; j++) {
      if (s[j] !== ' ' && s[j] !== '\t' && s[j] !== '\n' && s[j] !== '\r') {
        return s[j];
      }
    }
    return '';
  }

  // ── Helper: is position inside an object expecting a key? ──
  // True immediately after `{` or after a comma inside an object.
  function expectingKey() {
    if (top() !== '{') return false;
    var ls = lastSignificant(buf);
    return ls === '{' || ls === ',';
  }

  while (i < len) {
    var ch = s[i];

    // ════════════════════════════════════════════════════
    //  Inside a string
    // ════════════════════════════════════════════════════
    if (inStr) {
      if (esc) {
        // R12 — Invalid escape sequences: keep the character, drop the backslash
        //       for truly invalid escapes, but JSON.parse handles standard ones.
        var validEsc = '"\\\\/bfnrtu';
        if (validEsc.indexOf(ch) === -1) {
          // Not a valid JSON escape — remove the backslash we already emitted
          buf.pop();
        }
        buf.push(ch);
        esc = false;
        i++;
        continue;
      }
      if (ch === '\\') {
        esc = true;
        buf.push(ch);
        i++;
        continue;
      }
      if (ch === '"') {
        // Closing quote
        inStr = false;
        buf.push(ch);
        i++;
        continue;
      }
      // R1 (partial) — if the string was opened with ', accept ' as closer
      // (The opening ' was already converted to " before entering string mode)
      if (ch === "'") {
        // Treat as end of string (single-quote string mode)
        inStr = false;
        buf.push('"');
        i++;
        continue;
      }
      // Regular string character — handle control characters
      if (ch === '\n' || ch === '\r' || ch === '\t') {
        // Escape literal control characters inside strings
        var escMap = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };
        buf.push(escMap[ch]);
        i++;
        continue;
      }
      buf.push(ch);
      i++;
      continue;
    }

    // ════════════════════════════════════════════════════
    //  Outside a string — structural repair
    // ════════════════════════════════════════════════════

    // Skip whitespace (emit it)
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      buf.push(ch);
      i++;
      continue;
    }

    // ── R3/R4 — Trailing / consecutive commas ──
    if (ch === ',') {
      var nextSig = peekNonWS(i + 1);
      // Trailing comma before } or ]
      if (nextSig === '}' || nextSig === ']') {
        i++; // drop the comma
        continue;
      }
      // Consecutive commas
      if (nextSig === ',') {
        i++; // drop this comma, the next one will be evaluated
        continue;
      }
      // Trailing comma at EOF
      if (nextSig === '') {
        i++; // drop the comma — will be at end of input
        continue;
      }
      // Comma after opening { or [ (leading comma) — drop it
      if (buf.length > 0) {
        var lastSig = lastSignificant(buf);
        if (lastSig === '{' || lastSig === '[') {
          i++;
          continue;
        }
      }
      buf.push(ch);
      i++;
      continue;
    }

    // ── Opening brace / bracket ──
    if (ch === '{' || ch === '[') {
      // R5 — Missing comma: if the previous significant char was a value
      //       terminator (", digit, true/false/null closer, }, ]), we need a comma.
      if (buf.length > 0) {
        var prev = lastSignificant(buf);
        if (prev === '"' || prev === '}' || prev === ']' ||
            /[0-9]/.test(prev) || prev === 'e' || prev === 'l' ||  // true/false/null end chars
            prev === 's' /* for Python "False" → "false" */) {
          // But only if we're inside an array or after a value in an object
          if (top() === '[' || (top() === '{' && prev !== ':')) {
            buf.push(',');
          }
        }
      }
      // Nesting depth guard — prevent stack overflow from adversarial input
      if (stack.length >= MAX_NESTING_DEPTH) {
        i++; // skip this opening bracket
        continue;
      }
      stack.push(ch === '{' ? '{' : '[');
      buf.push(ch);
      i++;
      continue;
    }

    // ── Closing brace / bracket ──
    if (ch === '}' || ch === ']') {
      var expected = ch === '}' ? '{' : '[';
      if (top() === expected) {
        stack.pop();
        buf.push(ch);
      } else if (stack.length === 0) {
        // R11 — Extra closing bracket with no matching open — drop it
        // skip
      } else {
        // Mismatched close — try to auto-close intervening containers
        // e.g. stack is [ '{', '[' ] and we see '}', close the '[' first
        while (stack.length && top() !== expected) {
          buf.push((top() === '{') ? '}' : ']');
          stack.pop();
        }
        if (top() === expected) {
          stack.pop();
          buf.push(ch);
        }
      }
      i++;
      continue;
    }

    // ── R1 — Single quotes → double quotes ──
    if (ch === "'") {
      buf.push('"');
      inStr = true;
      i++;
      continue;
    }

    // ── Double-quote: start of string ──
    if (ch === '"') {
      // R5 — Missing comma before a new string value/key
      if (buf.length > 0) {
        var prevSig2 = lastSignificant(buf);
        // After a value-terminator inside an array, insert comma
        if (top() === '[' &&
            (prevSig2 === '"' || prevSig2 === '}' || prevSig2 === ']' ||
             /[0-9]/.test(prevSig2) || prevSig2 === 'e' || prevSig2 === 'l')) {
          buf.push(',');
        }
        // After a value in an object (not after a colon or comma or open-brace)
        if (top() === '{' &&
            prevSig2 !== ':' && prevSig2 !== ',' && prevSig2 !== '{' &&
            (prevSig2 === '"' || prevSig2 === '}' || prevSig2 === ']' ||
             /[0-9]/.test(prevSig2) || prevSig2 === 'e' || prevSig2 === 'l')) {
          buf.push(',');
        }
      }
      buf.push(ch);
      inStr = true;
      i++;
      continue;
    }

    // ── Colon ──
    if (ch === ':') {
      buf.push(ch);
      i++;
      continue;
    }

    // ── R8 — Illegal literal tokens (NaN, Infinity, undefined, Python bools) ──
    var illegalMatch = matchIllegalLiteral(s, i);
    if (illegalMatch) {
      buf.push(ILLEGAL_LITERALS[illegalMatch]);
      i += illegalMatch.length;
      continue;
    }

    // ── R2 — Unquoted keys ──
    if (isKeyStart(ch) && expectingKey()) {
      var keyStart = i;
      while (i < len && isKeyChar(s[i])) { i++; }
      var key = s.substring(keyStart, i);
      buf.push('"' + key + '"');
      continue;
    }

    // ── Standard JSON literals: true, false, null ──
    if (s.substring(i, i + 4) === 'true') {
      buf.push('true');
      i += 4;
      continue;
    }
    if (s.substring(i, i + 5) === 'false') {
      buf.push('false');
      i += 5;
      continue;
    }
    if (s.substring(i, i + 4) === 'null') {
      buf.push('null');
      i += 4;
      continue;
    }

    // ── Numbers (including negative, decimal, exponent) ──
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      // R5 — Missing comma before a number in an array
      if (top() === '[' && buf.length > 0) {
        var prevNum = lastSignificant(buf);
        if (/[0-9]/.test(prevNum) || prevNum === '"' || prevNum === '}' ||
            prevNum === ']' || prevNum === 'e' || prevNum === 'l') {
          buf.push(',');
        }
      }
      var numStr = '';
      while (i < len && /[0-9eE.+\-]/.test(s[i])) {
        numStr += s[i];
        i++;
      }
      buf.push(numStr);
      continue;
    }

    // ── Unrecognised character — skip it (best-effort) ──
    i++;
  }

  // ════════════════════════════════════════════════════
  //  R6/R7/R10 — Close any structures left open at EOF
  // ════════════════════════════════════════════════════

  // R6 — Truncated string: close the dangling string
  if (inStr) {
    buf.push('"');
  }

  // R10 — If we ended right after a colon (key with no value), insert null
  var lastSigChar = lastSignificant(buf);
  if (lastSigChar === ':') {
    buf.push('null');
  }
  // Handle trailing comma at the very end — walk backwards through buf
  // to find and remove it, but ONLY if it's outside any string.
  if (lastSigChar === ',') {
    // Remove the trailing comma element from the buffer.
    // Walk backwards skipping whitespace entries to find the ',' entry.
    for (var r = buf.length - 1; r >= 0; r--) {
      var rc = buf[r];
      if (rc === ' ' || rc === '\t' || rc === '\n' || rc === '\r') continue;
      if (rc === ',') {
        buf.splice(r, 1);
        break;
      }
      break; // not a comma — stop
    }
  }

  // R7 — Close remaining containers in reverse order
  while (stack.length) {
    var container = stack.pop();
    buf.push((container === '{') ? '}' : ']');
  }

  return buf.join('');
}

// ─────────────────────────────────────────────────────────
//  Phase 2 — Parse: validate and return
// ─────────────────────────────────────────────────────────

/**
 * Repair and parse broken JSON produced by LLMs.
 *
 * Accepts raw LLM output that may contain Markdown fences, comments,
 * surrounding prose, truncated structures, trailing commas, single
 * quotes, unquoted keys, illegal values, and other common defects.
 *
 * Returns a parsed JavaScript value on success, or a diagnostic
 * object `{ error, raw, diag }` on failure — so callers never need
 * to wrap calls in try/catch.
 *
 * @param {string} input  Raw LLM output string.
 * @returns {*}           Parsed value, or `{ error, raw, diag }` on failure.
 *
 * @example
 *   jsonguard('{"name": "Shrimp",}')
 *   // => { name: 'Shrimp' }
 *
 * @example
 *   jsonguard('```json\n[1, 2, 3')
 *   // => [1, 2, 3]
 */
function jsonguard(input) {
  // Fast path — if input is already valid JSON, skip all repair work.
  if (typeof input === 'string') {
    // Input size guard — reject oversized payloads early.
    if (input.length > MAX_INPUT_LENGTH) {
      return {
        error: 'Input too large',
        raw: input.substring(0, 200) + '…',
        diag: 'Input length ' + input.length + ' exceeds MAX_INPUT_LENGTH ' + MAX_INPUT_LENGTH
      };
    }
    try {
      return JSON.parse(input);
    } catch (_) { /* proceed to repair */ }
  }

  var extracted = extractJSON(input);
  var repaired  = repairJSON(extracted);

  try {
    return JSON.parse(repaired);
  } catch (e) {
    return { error: 'Repair failed', raw: repaired, diag: e.message };
  }
}

// ─────────────────────────────────────────────────────────
//  Public API
// ─────────────────────────────────────────────────────────

module.exports = jsonguard;
module.exports.jsonguard       = jsonguard;       // named export for ESM compat
module.exports.extractJSON       = extractJSON;       // advanced: noise stripping only
module.exports.repairJSON        = repairJSON;        // advanced: structural repair only
module.exports.MAX_INPUT_LENGTH  = MAX_INPUT_LENGTH;  // configurable size guard
module.exports.MAX_NESTING_DEPTH = MAX_NESTING_DEPTH; // configurable depth guard
