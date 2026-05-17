/**
 * @file test.js
 * @description Stress-test suite for JSONGuard v1.4.1
 *
 * 40+ test cases spanning every repair strategy, from basic passthrough
 * to hell-level compound failures.  Uses a zero-dependency mini runner
 * so the project stays true to its "one file, one `node test.js`" ethos.
 *
 * Run:  node test.js
 *
 * @version 1.4.1
 * @license MIT
 */

'use strict';

var jsonguard = require('./jsonguard');

// ─────────────────────────────────────────────────────────
//  Mini test runner (zero dependencies)
// ─────────────────────────────────────────────────────────

var passed = 0;
var failed = 0;
var errors = [];

/**
 * Assert that jsonguard(input) deeply equals the expected value.
 *
 * @param {string} label    Human-readable test name.
 * @param {string} input    Raw LLM output to feed into jsonguard.
 * @param {*}      expected The expected parsed result.
 */
function test(label, input, expected) {
  var result = jsonguard(input);
  var ok = deepEqual(result, expected);
  if (ok) {
    passed++;
    console.log('  \x1b[32m✓\x1b[0m ' + label);
  } else {
    failed++;
    errors.push({ label: label, input: input, expected: expected, got: result });
    console.log('  \x1b[31m✗\x1b[0m ' + label);
    console.log('    expected:', JSON.stringify(expected));
    console.log('    got:     ', JSON.stringify(result));
  }
}

/** Naive deep-equal (sufficient for JSON values). */
function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  var keysA = Object.keys(a);
  var keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (var i = 0; i < keysA.length; i++) {
    if (!deepEqual(a[keysA[i]], b[keysA[i]])) return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────
//  Test cases
// ─────────────────────────────────────────────────────────

console.log('\n🦐 JSONGuard v1.4.1 — Stress Test Suite\n');
console.log('═══════════════════════════════════════\n');

// ── 1. Basics ────────────────────────────────────────────

console.log('▸ Basics');

test('Valid JSON passthrough (object)',
  '{"name":"Shrimp","level":99}',
  { name: 'Shrimp', level: 99 });

test('Valid JSON passthrough (array)',
  '[1, 2, 3]',
  [1, 2, 3]);

test('Valid JSON passthrough (nested)',
  '{"a":{"b":[1,2,{"c":true}]}}',
  { a: { b: [1, 2, { c: true }] } });

// ── 2. Markdown fences ───────────────────────────────────

console.log('\n▸ Markdown Fences');

test('```json wrapper',
  '```json\n{"status":"ok"}\n```',
  { status: 'ok' });

test('```JSON (uppercase)',
  '```JSON\n{"status":"ok"}\n```',
  { status: 'ok' });

test('```js wrapper',
  '```js\n{"status":"ok"}\n```',
  { status: 'ok' });

test('```javascript wrapper',
  '```javascript\n[1,2,3]\n```',
  [1, 2, 3]);

test('Bare ``` wrapper',
  '```\n{"a":1}\n```',
  { a: 1 });

// ── 3. Leading prose / noise ─────────────────────────────

console.log('\n▸ Leading Prose');

test('Prose before JSON object',
  'Here is the JSON output:\n{"result": 42}',
  { result: 42 });

test('Prose before JSON array',
  'The data is: [10, 20, 30]',
  [10, 20, 30]);

test('LLM rambling + Markdown fence',
  'Sure! Here is your data:\n```json\n{"hero":"Shrimp"}\n```\nHope this helps!',
  { hero: 'Shrimp' });

// ── 4. Truncated structures ─────────────────────────────

console.log('\n▸ Truncation');

test('Truncated string value',
  '{"name": "Shri',
  { name: 'Shri' });

test('Truncated after colon (missing value)',
  '{"name":',
  { name: null });

test('Truncated object (missing closing brace)',
  '{"name": "Shrimp", "level": 99',
  { name: 'Shrimp', level: 99 });

test('Truncated nested object',
  '{"user": {"name": "Shrimp", "stats": {"hp": 100',
  { user: { name: 'Shrimp', stats: { hp: 100 } } });

test('Truncated array',
  '[1, 2, 3',
  [1, 2, 3]);

test('Truncated array of objects',
  '[{"id":1},{"id":2',
  [{ id: 1 }, { id: 2 }]);

// ── 5. Trailing commas ──────────────────────────────────

console.log('\n▸ Trailing Commas');

test('Object trailing comma',
  '{"a":1, "b":2,}',
  { a: 1, b: 2 });

test('Array trailing comma',
  '[1, 2, 3,]',
  [1, 2, 3]);

test('Deep nested trailing commas',
  '{"a": [1, 2,], "b": {"c": 3,},}',
  { a: [1, 2], b: { c: 3 } });

// ── 6. Single quotes ────────────────────────────────────

console.log('\n▸ Single Quotes');

test('Single-quoted keys and values',
  "{'name': 'Shrimp', 'clan': 'One Dollar'}",
  { name: 'Shrimp', clan: 'One Dollar' });

// ── 7. Unquoted keys ────────────────────────────────────

console.log('\n▸ Unquoted Keys');

test('Simple unquoted keys',
  '{name: "Shrimp", level: 99}',
  { name: 'Shrimp', level: 99 });

test('Nested unquoted keys',
  '{user: {name: "Shrimp", stats: {hp: 100}}}',
  { user: { name: 'Shrimp', stats: { hp: 100 } } });

// ── 7b. Dash / dot in unquoted keys (蝦馬仕 bug #1) ────

test('Kebab-case unquoted key',
  '{my-key: 1, another-one: 2}',
  { 'my-key': 1, 'another-one': 2 });

test('Dotted unquoted key',
  '{my.key: "value"}',
  { 'my.key': 'value' });

// ── 8. Illegal values ───────────────────────────────────

console.log('\n▸ Illegal Values');

test('NaN → null',
  '{"value": NaN}',
  { value: null });

test('Infinity → null',
  '{"value": Infinity}',
  { value: null });

test('undefined → null',
  '{"value": undefined}',
  { value: null });

test('Python True/False/None',
  '{"a": True, "b": False, "c": None}',
  { a: true, b: false, c: null });

// ── 9. Comments ─────────────────────────────────────────

console.log('\n▸ Comments');

test('Line comments',
  '{\n  "a": 1, // this is a comment\n  "b": 2\n}',
  { a: 1, b: 2 });

test('Block comments',
  '{"a": /* inline */ 1, "b": 2}',
  { a: 1, b: 2 });

// ── 10. Missing commas ──────────────────────────────────

console.log('\n▸ Missing Commas');

test('Missing comma between object members',
  '{"a": 1 "b": 2}',
  { a: 1, b: 2 });

test('Missing comma between array elements (strings)',
  '["a" "b" "c"]',
  ['a', 'b', 'c']);

// ── 11. Consecutive commas ──────────────────────────────

console.log('\n▸ Consecutive Commas');

test('Consecutive commas in array',
  '[1,,2,,,3]',
  [1, 2, 3]);

// ── 12. Edge cases ──────────────────────────────────────

console.log('\n▸ Edge Cases');

test('Empty object',
  '{}',
  {});

test('Empty array',
  '[]',
  []);

// ── 13. Trailing comma in string (蝦馬仕 bug #2) ────────

console.log('\n▸ Trailing Comma In String (Bug Fix)');

test('Truncated after value containing comma',
  '{"msg": "hello, world",',
  { msg: 'hello, world' });

test('Value with commas + truncation',
  '{"items": "a, b, c", "count": 3,',
  { items: 'a, b, c', count: 3 });

test('Nested commas in string values',
  '{"addr": "123 Main St, Suite 4, NY",}',
  { addr: '123 Main St, Suite 4, NY' });

// ── 14. Hell-level compound failures ─────────────────────

console.log('\n▸ Hell-Level Compound');

test('Markdown + trailing comma + truncation',
  '```json\n{"name": "Shrimp Clan", "status": "Hero",',
  { name: 'Shrimp Clan', status: 'Hero' });

test('Prose + single-quotes + illegal values + truncation',
  "Here is the result: {'score': Infinity, 'valid': True, 'data': [1, 2",
  { score: null, valid: true, data: [1, 2] });

test('Kebab keys + trailing comma + truncation',
  '{my-key: "val", another-key: [1, 2,',
  { 'my-key': 'val', 'another-key': [1, 2] });

// ─────────────────────────────────────────────────────────
//  Results
// ─────────────────────────────────────────────────────────

console.log('\n═══════════════════════════════════════');
console.log('  Total:  ' + (passed + failed));
console.log('  \x1b[32mPassed: ' + passed + '\x1b[0m');
if (failed > 0) {
  console.log('  \x1b[31mFailed: ' + failed + '\x1b[0m\n');
  console.log('Failed tests:');
  for (var f = 0; f < errors.length; f++) {
    console.log('  • ' + errors[f].label);
  }
  process.exit(1);
} else {
  console.log('  Failed: 0');
  console.log('\n  \x1b[32m🦐 All tests passed! JSONGuard v1.4.1 is battle-ready. ⚔️\x1b[0m\n');
}
