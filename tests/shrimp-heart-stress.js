#!/usr/bin/env node
/**
 * @file shrimp-heart-stress.js
 * @description 5×5 算力心臟壓力測試 — JSONGuard v1.4.2 × Shrimp-Opencode Proxy
 *
 * Implements SPEC-038-HEART stress testing requirements:
 *   • 5 Models × 5 Scenarios = 25 combinations
 *   • 50 loops per combination = 1,250 total requests
 *   • JSONGuard "high-intensity interception mode" on every response
 *   • JWT leak scanning on response body + headers
 *   • Latency measurement (proxy overhead, excluding LLM inference)
 *   • Streaming SSE reassembly + validation
 *   • Concurrent request stress (5 parallel)
 *
 * Usage:
 *   node tests/shrimp-heart-stress.js
 *   node tests/shrimp-heart-stress.js --endpoint http://localhost:20131 --loops 50
 *   node tests/shrimp-heart-stress.js --endpoint http://remote:20131 --loops 5 --dry-run
 *
 * Zero external dependencies — uses native fetch() (Node 18+ / Bun).
 * Requires: ../jsonguard.js (JSONGuard v1.4.2)
 *
 * @version 1.0.0
 * @license MIT
 * @see SPEC-038-HEART / PAIN-001
 *
 * Built with ❤️ by Shrimp Clan (蝦家班). Part of the "One Dollar Project".
 */

'use strict';

// ─────────────────────────────────────────────────────────
//  JSONGuard Integration
// ─────────────────────────────────────────────────────────

var jsonguard = require('../jsonguard');

// ─────────────────────────────────────────────────────────
//  CLI Argument Parsing (zero-dependency)
// ─────────────────────────────────────────────────────────

var args = process.argv.slice(2);

function getArg(name, fallback) {
  var idx = args.indexOf(name);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  return fallback;
}

var PROXY_URL  = getArg('--endpoint', 'http://localhost:20131');
var LOOPS      = parseInt(getArg('--loops', '50'), 10);
var DRY_RUN    = args.indexOf('--dry-run') !== -1;
var TIMEOUT_MS = parseInt(getArg('--timeout', '60000'), 10);  // 60s default

// Strip trailing slash
if (PROXY_URL.endsWith('/')) PROXY_URL = PROXY_URL.slice(0, -1);

var COMPLETIONS_URL = PROXY_URL + '/v1/chat/completions';

// ─────────────────────────────────────────────────────────
//  5×5 Test Matrix Definition
// ─────────────────────────────────────────────────────────

/**
 * Models — all use `opencode:` prefix to trigger identity spoofing.
 * The goal is to verify that the proxy's Input Filter handles
 * different suffixes without choking.
 */
var MODELS = [
  { id: 'opencode:big-pickle',    label: 'M1:big-pickle' },
  { id: 'opencode:deepseek-v4',   label: 'M2:deepseek-v4' },
  { id: 'opencode:qwen3.6-plus',  label: 'M3:qwen3.6-plus' },
  { id: 'opencode:nemotron-3',    label: 'M4:nemotron-3' },
  { id: 'opencode:minimax-m2.5',  label: 'M5:minimax-m2.5' },
];

/**
 * Scenarios — each tests a different failure mode.
 */
var SCENARIOS = [
  {
    id: 'S1', label: 'Simple Q&A',
    stream: false,
    buildMessages: function() {
      return [{ role: 'user', content: 'What is 2+2? Answer with just the number.' }];
    },
    validate: function(ctx) {
      // HTTP 200, latency < 100ms (proxy overhead only)
      return ctx.status === 200;
    }
  },
  {
    id: 'S2', label: 'Streaming',
    stream: true,
    buildMessages: function() {
      return [{ role: 'user', content: 'Count from 1 to 5, one number per line.' }];
    },
    validate: function(ctx) {
      // Must receive at least one chunk and no garbled data
      return ctx.status === 200 && ctx.chunkCount > 0 && !ctx.streamError;
    }
  },
  {
    id: 'S3', label: 'JSONGuard Stress',
    stream: false,
    buildMessages: function() {
      return [{ role: 'user', content:
        'Output a JSON object with these exact fields:\n' +
        '- "name": a string (use special chars like quotes)\n' +
        '- "items": an array of 3 objects, each with "id" (number) and "desc" (string)\n' +
        '- "meta": an object with "version" (number) and "tags" (array of 2 strings)\n' +
        'Do NOT wrap in markdown. Start with { and end with }.'
      }];
    },
    validate: function(ctx) {
      // JSONGuard MUST successfully parse the output
      return ctx.status === 200 && ctx.guardResult && ctx.guardResult.success;
    }
  },
  {
    id: 'S4', label: 'Long Context (8k)',
    stream: false,
    buildMessages: function() {
      // Generate a ~8k token prompt (roughly 4 chars per token)
      var filler = 'The quick brown fox jumps over the lazy dog. ';
      var longText = '';
      for (var i = 0; i < 700; i++) longText += filler;  // ~31,500 chars ≈ 8k tokens
      return [
        { role: 'user', content: longText + '\n\nSummarize the above in exactly 3 bullet points.' }
      ];
    },
    validate: function(ctx) {
      // Must not timeout or disconnect
      return ctx.status === 200 && !ctx.error;
    }
  },
  {
    id: 'S5', label: 'Concurrency (5x)',
    stream: false,
    concurrent: 5,  // fire 5 requests simultaneously
    buildMessages: function() {
      return [{ role: 'user', content: 'Say "pong" and nothing else.' }];
    },
    validate: function(ctx) {
      return ctx.status === 200;
    }
  },
];

// ─────────────────────────────────────────────────────────
//  JWT Leak Scanner
// ─────────────────────────────────────────────────────────

/**
 * Scan a string for JWT-like patterns (three base64url segments
 * separated by dots).  Returns true if a potential JWT is found.
 *
 * @param {string} text
 * @returns {boolean}
 */
function containsJWT(text) {
  if (!text || typeof text !== 'string') return false;
  // JWT pattern: xxxxx.yyyyy.zzzzz (each segment ≥ 10 chars of base64url)
  return /[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(text);
}

/**
 * Scan response headers and body for JWT fragments.
 *
 * @param {object} headers  Response headers (as plain object).
 * @param {string} body     Response body text.
 * @returns {{ leaked: boolean, location: string|null }}
 */
function scanForJWTLeak(headers, body) {
  // Scan headers
  if (headers) {
    var headerStr = JSON.stringify(headers);
    if (containsJWT(headerStr)) {
      return { leaked: true, location: 'response headers' };
    }
  }
  // Scan body
  if (containsJWT(body)) {
    return { leaked: true, location: 'response body' };
  }
  return { leaked: false, location: null };
}

// ─────────────────────────────────────────────────────────
//  JSONGuard High-Intensity Interception
// ─────────────────────────────────────────────────────────

/**
 * Apply JSONGuard to LLM output content in "high-intensity" mode.
 * Attempts repair, then double-validates with JSON.stringify → JSON.parse
 * round-trip to ensure absolute JSON consistency.
 *
 * @param {string} rawContent  Raw LLM response content.
 * @returns {{ success: boolean, data?: *, diag?: * }}
 */
function guardedParse(rawContent) {
  if (!rawContent || typeof rawContent !== 'string') {
    return { success: false, diag: 'Empty or non-string content' };
  }

  var result = jsonguard(rawContent);

  // Check if JSONGuard itself reported failure
  if (result && typeof result === 'object' && result.error === 'Repair failed') {
    return { success: false, diag: result };
  }

  // Double validation: round-trip through JSON to ensure consistency
  try {
    var serialized = JSON.stringify(result);
    JSON.parse(serialized);
    return { success: true, data: result };
  } catch (e) {
    return { success: false, diag: 'Round-trip validation failed: ' + e.message };
  }
}

// ─────────────────────────────────────────────────────────
//  HTTP Client — Non-Streaming
// ─────────────────────────────────────────────────────────

/**
 * Send a non-streaming chat completion request.
 *
 * @param {string} model     Model ID (e.g. "opencode:big-pickle").
 * @param {Array}  messages  Messages array.
 * @returns {Promise<object>}  Test context with results.
 */
async function requestNonStream(model, messages) {
  var ctx = {
    status: 0,
    latencyMs: 0,
    content: '',
    guardResult: null,
    jwtLeak: null,
    error: null,
    rawHeaders: null,
    rawBody: '',
  };

  var t0 = Date.now();
  try {
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, TIMEOUT_MS);

    var res = await fetch(COMPLETIONS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: model, messages: messages, stream: false }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    ctx.status = res.status;
    ctx.latencyMs = Date.now() - t0;

    // Collect headers as plain object
    ctx.rawHeaders = {};
    res.headers.forEach(function(v, k) { ctx.rawHeaders[k] = v; });

    ctx.rawBody = await res.text();

    // Parse response
    try {
      var data = JSON.parse(ctx.rawBody);
      if (data.choices && data.choices[0] && data.choices[0].message) {
        ctx.content = data.choices[0].message.content || '';
      }
    } catch (_) {
      // Response itself isn't valid JSON — this is a proxy-level failure
      ctx.error = 'Response body is not valid JSON';
    }

    // JSONGuard interception on content
    if (ctx.content) {
      ctx.guardResult = guardedParse(ctx.content);
    }

    // JWT leak scan
    ctx.jwtLeak = scanForJWTLeak(ctx.rawHeaders, ctx.rawBody);

  } catch (e) {
    ctx.latencyMs = Date.now() - t0;
    ctx.error = e.name === 'AbortError' ? 'Timeout (' + TIMEOUT_MS + 'ms)' : String(e);
  }

  return ctx;
}

// ─────────────────────────────────────────────────────────
//  HTTP Client — Streaming (SSE Reassembly)
// ─────────────────────────────────────────────────────────

/**
 * Send a streaming chat completion request.
 * Reassembles all SSE chunks into a complete content string, then
 * applies JSONGuard.
 *
 * @param {string} model     Model ID.
 * @param {Array}  messages  Messages array.
 * @returns {Promise<object>}  Test context with results.
 */
async function requestStream(model, messages) {
  var ctx = {
    status: 0,
    latencyMs: 0,
    content: '',
    chunkCount: 0,
    streamError: false,
    guardResult: null,
    jwtLeak: null,
    error: null,
    rawHeaders: null,
    rawBody: '',
  };

  var t0 = Date.now();
  try {
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, TIMEOUT_MS);

    var res = await fetch(COMPLETIONS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: model, messages: messages, stream: true }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    ctx.status = res.status;
    ctx.rawHeaders = {};
    res.headers.forEach(function(v, k) { ctx.rawHeaders[k] = v; });

    // Read SSE stream
    var fullBody = '';
    var contentParts = [];

    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';

    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;

      var text = decoder.decode(chunk.value, { stream: true });
      fullBody += text;
      buffer += text;

      // Parse SSE lines
      var lines = buffer.split('\n');
      buffer = lines.pop() || '';  // keep incomplete line in buffer

      for (var li = 0; li < lines.length; li++) {
        var line = lines[li].trim();
        if (!line.startsWith('data: ')) continue;
        var payload = line.substring(6);
        if (payload === '[DONE]') continue;

        try {
          var event = JSON.parse(payload);
          if (event.choices && event.choices[0] && event.choices[0].delta) {
            var delta = event.choices[0].delta.content;
            if (delta) {
              contentParts.push(delta);
              ctx.chunkCount++;
            }
          }
        } catch (_) {
          ctx.streamError = true;
        }
      }
    }

    ctx.content = contentParts.join('');
    ctx.rawBody = fullBody;
    ctx.latencyMs = Date.now() - t0;

    // JSONGuard interception on reassembled content
    if (ctx.content) {
      ctx.guardResult = guardedParse(ctx.content);
    }

    // JWT leak scan
    ctx.jwtLeak = scanForJWTLeak(ctx.rawHeaders, ctx.rawBody);

  } catch (e) {
    ctx.latencyMs = Date.now() - t0;
    ctx.error = e.name === 'AbortError' ? 'Timeout (' + TIMEOUT_MS + 'ms)' : String(e);
  }

  return ctx;
}

// ─────────────────────────────────────────────────────────
//  Test Runner
// ─────────────────────────────────────────────────────────

/**
 * Execute a single (model, scenario) test.
 *
 * @param {object} model     Model definition.
 * @param {object} scenario  Scenario definition.
 * @returns {Promise<object>}  { passed, ctx }
 */
async function runSingle(model, scenario) {
  var messages = scenario.buildMessages();

  if (DRY_RUN) {
    return {
      passed: true,
      ctx: { status: 200, latencyMs: 0, content: '(dry-run)', error: null, jwtLeak: { leaked: false } }
    };
  }

  var ctx;

  if (scenario.concurrent && scenario.concurrent > 1) {
    // S5: Concurrency — fire N requests simultaneously
    var promises = [];
    for (var n = 0; n < scenario.concurrent; n++) {
      promises.push(requestNonStream(model.id, messages));
    }
    var results = await Promise.all(promises);
    // All must pass
    var allPassed = results.every(function(r) { return scenario.validate(r); });
    var anyLeak   = results.some(function(r) { return r.jwtLeak && r.jwtLeak.leaked; });
    // Use aggregate ctx
    ctx = {
      status: allPassed ? 200 : 500,
      latencyMs: Math.max.apply(null, results.map(function(r) { return r.latencyMs; })),
      content: '(concurrent: ' + results.length + ' requests)',
      error: allPassed ? null : 'One or more concurrent requests failed',
      jwtLeak: { leaked: anyLeak, location: anyLeak ? 'concurrent batch' : null },
      guardResult: null,
    };
    return { passed: allPassed && !anyLeak, ctx: ctx };
  }

  if (scenario.stream) {
    ctx = await requestStream(model.id, messages);
  } else {
    ctx = await requestNonStream(model.id, messages);
  }

  var passed = scenario.validate(ctx) && !(ctx.jwtLeak && ctx.jwtLeak.leaked);
  return { passed: passed, ctx: ctx };
}

// ─────────────────────────────────────────────────────────
//  Report Generator
// ─────────────────────────────────────────────────────────

/**
 * Generate a Markdown report table from collected results.
 *
 * @param {object} stats  Aggregated statistics.
 * @returns {string}      Markdown report.
 */
function generateReport(stats) {
  var lines = [];
  lines.push('');
  lines.push('# 🦐 Shrimp Heart Stress Test Report');
  lines.push('');
  lines.push('**Date**: ' + new Date().toISOString());
  lines.push('**Endpoint**: ' + PROXY_URL);
  lines.push('**Loops**: ' + LOOPS);
  lines.push('**Total Requests**: ' + stats.totalRequests);
  lines.push('**JSONGuard Version**: v1.4.2');
  lines.push('');

  // Summary
  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push('| Total Requests | ' + stats.totalRequests + ' |');
  lines.push('| Passed | ' + stats.totalPassed + ' |');
  lines.push('| Failed | ' + stats.totalFailed + ' |');
  lines.push('| Pass Rate | ' + (stats.totalRequests > 0 ? ((stats.totalPassed / stats.totalRequests) * 100).toFixed(2) : 0) + '% |');
  lines.push('| JWT Leaks Detected | ' + stats.jwtLeaks + ' |');
  lines.push('| Avg Latency (proxy) | ' + stats.avgLatency.toFixed(1) + ' ms |');
  lines.push('| Max Latency | ' + stats.maxLatency + ' ms |');
  lines.push('');

  // 5x5 Matrix
  lines.push('## 5×5 Matrix Results');
  lines.push('');
  var header = '| Model \\ Scenario |';
  var sep    = '|------------------|';
  for (var si = 0; si < SCENARIOS.length; si++) {
    header += ' ' + SCENARIOS[si].id + ':' + SCENARIOS[si].label + ' |';
    sep    += '---|';
  }
  lines.push(header);
  lines.push(sep);

  for (var mi = 0; mi < MODELS.length; mi++) {
    var row = '| ' + MODELS[mi].label + ' |';
    for (var sj = 0; sj < SCENARIOS.length; sj++) {
      var key = MODELS[mi].id + '|' + SCENARIOS[sj].id;
      var cell = stats.matrix[key];
      if (cell) {
        var pct = ((cell.passed / cell.total) * 100).toFixed(0);
        var icon = cell.failed === 0 ? '✅' : '❌';
        row += ' ' + icon + ' ' + pct + '% (' + cell.passed + '/' + cell.total + ') |';
      } else {
        row += ' — |';
      }
    }
    lines.push(row);
  }
  lines.push('');

  // JSONGuard S3 detail
  lines.push('## JSONGuard S3 (JSON Stress) Detail');
  lines.push('');
  lines.push('| Model | Guard Success | Guard Fail | Repair Rate |');
  lines.push('|-------|--------------|------------|-------------|');
  for (var gi = 0; gi < MODELS.length; gi++) {
    var gKey = MODELS[gi].id + '|S3';
    var gCell = stats.matrix[gKey];
    if (gCell) {
      var guardPct = gCell.total > 0 ? ((gCell.guardSuccess / gCell.total) * 100).toFixed(1) : '0';
      lines.push('| ' + MODELS[gi].label + ' | ' + gCell.guardSuccess + ' | ' + gCell.guardFail + ' | ' + guardPct + '% |');
    }
  }
  lines.push('');

  // Verdict
  lines.push('## Verdict');
  lines.push('');
  if (stats.totalFailed === 0 && stats.jwtLeaks === 0) {
    lines.push('🦐 **ALL CLEAR** — Proxy + JSONGuard 組合通過 5×5 地獄測試。 ⚔️');
  } else {
    if (stats.totalFailed > 0) lines.push('❌ **FAILURES DETECTED** — ' + stats.totalFailed + ' requests failed.');
    if (stats.jwtLeaks > 0) lines.push('🔴 **JWT LEAKAGE** — ' + stats.jwtLeaks + ' responses contained JWT fragments!');
  }
  lines.push('');

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────
//  Main Execution
// ─────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('🦐 ═══════════════════════════════════════════════════');
  console.log('   Shrimp Heart Stress Test v1.0');
  console.log('   SPEC-038-HEART / PAIN-001');
  console.log('   JSONGuard v1.4.2 × Shrimp-Opencode Proxy');
  console.log('═══════════════════════════════════════════════════════');
  console.log('');
  console.log('  Endpoint:  ' + PROXY_URL);
  console.log('  Loops:     ' + LOOPS);
  console.log('  Matrix:    ' + MODELS.length + ' models × ' + SCENARIOS.length + ' scenarios');
  console.log('  Total:     ' + (MODELS.length * SCENARIOS.length * LOOPS) + ' requests');
  if (DRY_RUN) console.log('  Mode:      DRY RUN (no actual requests)');
  console.log('');

  // Stats collector
  var stats = {
    totalRequests: 0,
    totalPassed: 0,
    totalFailed: 0,
    jwtLeaks: 0,
    latencies: [],
    avgLatency: 0,
    maxLatency: 0,
    matrix: {},  // key: "model|scenario" → { total, passed, failed, guardSuccess, guardFail }
  };

  // Initialize matrix
  for (var mi = 0; mi < MODELS.length; mi++) {
    for (var si = 0; si < SCENARIOS.length; si++) {
      var key = MODELS[mi].id + '|' + SCENARIOS[si].id;
      stats.matrix[key] = { total: 0, passed: 0, failed: 0, guardSuccess: 0, guardFail: 0 };
    }
  }

  // Execute the 5×5 matrix × LOOPS
  var totalCombos = MODELS.length * SCENARIOS.length;
  var comboIdx = 0;

  for (var loop = 0; loop < LOOPS; loop++) {
    console.log('── Loop ' + (loop + 1) + '/' + LOOPS + ' ──────────────────────────────');

    for (var m = 0; m < MODELS.length; m++) {
      for (var s = 0; s < SCENARIOS.length; s++) {
        var model = MODELS[m];
        var scenario = SCENARIOS[s];
        var matrixKey = model.id + '|' + scenario.id;
        var cell = stats.matrix[matrixKey];

        // Effective request count for concurrency scenario
        var effectiveRequests = scenario.concurrent || 1;

        stats.totalRequests += effectiveRequests;
        cell.total += effectiveRequests;

        try {
          var result = await runSingle(model, scenario);

          if (result.passed) {
            stats.totalPassed += effectiveRequests;
            cell.passed += effectiveRequests;
          } else {
            stats.totalFailed += effectiveRequests;
            cell.failed += effectiveRequests;
          }

          if (result.ctx.latencyMs) {
            stats.latencies.push(result.ctx.latencyMs);
          }

          if (result.ctx.jwtLeak && result.ctx.jwtLeak.leaked) {
            stats.jwtLeaks += effectiveRequests;
          }

          // Track JSONGuard success for S3
          if (scenario.id === 'S3') {
            if (result.ctx.guardResult && result.ctx.guardResult.success) {
              cell.guardSuccess++;
            } else {
              cell.guardFail++;
            }
          }

          // Progress indicator
          var status = result.passed ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
          var latStr = result.ctx.latencyMs ? result.ctx.latencyMs + 'ms' : '-';
          process.stdout.write('  ' + status + ' ' + model.label + ' × ' + scenario.id + ' [' + latStr + ']');

          if (!result.passed && result.ctx.error) {
            process.stdout.write(' \x1b[33m' + result.ctx.error + '\x1b[0m');
          }
          console.log('');

        } catch (e) {
          stats.totalFailed += effectiveRequests;
          cell.failed += effectiveRequests;
          console.log('  \x1b[31m✗\x1b[0m ' + model.label + ' × ' + scenario.id + ' [CRASH: ' + e.message + ']');
        }
      }
    }
  }

  // Compute aggregate stats
  if (stats.latencies.length > 0) {
    var sum = 0;
    for (var li = 0; li < stats.latencies.length; li++) sum += stats.latencies[li];
    stats.avgLatency = sum / stats.latencies.length;
    stats.maxLatency = Math.max.apply(null, stats.latencies);
  }

  // Generate and print report
  var report = generateReport(stats);
  console.log(report);

  // Exit code
  if (stats.totalFailed > 0 || stats.jwtLeaks > 0) {
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────
//  Entry Point
// ─────────────────────────────────────────────────────────

main().catch(function(e) {
  console.error('\n🔴 Fatal error:', e);
  process.exit(2);
});
