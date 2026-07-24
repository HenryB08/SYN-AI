#!/usr/bin/env node
/* run-tests.mjs — one-command runner for every suite in tests/ plus the size guard.
 *
 * Why this exists: the project has ~12 headless-Chromium suites plus a file-based
 * size guard. Running them by hand is error-prone and parallel runs have caused
 * flakes (each launches its own Chromium). This runner executes them SEQUENTIALLY,
 * parses each suite's `CHECKS: N passed, M failed` line, and prints one summary
 * table with a correct exit code.
 *
 * Flake handling: three suites fail transiently under headless timing
 * (premium-motion — a scroll-reveal opacity sample; pricing-model — the two-page
 * join flow; guide-access — a smooth-scroll timing check). They are timing
 * artifacts, not defects. So a suite that fails is retried ONCE:
 *   - passes on retry  -> FLAKY  (build stays green)
 *   - fails on retry    -> FAILED (build goes red)
 * This gives an honest signal without hiding real failures.
 *
 * Usage:
 *   node scripts/run-tests.mjs              # run everything
 *   node scripts/run-tests.mjs --only pricing-model
 *   npm test                                # same as the first form
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TESTS_DIR = join(ROOT, 'tests');
const PER_SUITE_TIMEOUT_MS = 240_000; // generous: pricing-model has needed >90s

// --only <name>
const args = process.argv.slice(2);
let only = null;
const oi = args.indexOf('--only');
if (oi !== -1) only = (args[oi + 1] || '').replace(/\.mjs$/, '');

// Discover suites. size-guard runs first (fast, structural); the rest alphabetically.
let suites = readdirSync(TESTS_DIR).filter(f => f.endsWith('.mjs')).sort();
suites = ['size-guard.mjs', ...suites.filter(f => f !== 'size-guard.mjs')];
if (only) {
  suites = suites.filter(f => f.replace(/\.mjs$/, '') === only);
  if (!suites.length) {
    console.error(`No suite matches --only "${only}". Available: ${readdirSync(TESTS_DIR).filter(f => f.endsWith('.mjs')).map(f => f.replace(/\.mjs$/, '')).join(', ')}`);
    process.exit(2);
  }
}

function runOnce(file) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [join(TESTS_DIR, file)], {
    cwd: ROOT, encoding: 'utf8', timeout: PER_SUITE_TIMEOUT_MS,
  });
  const ms = Date.now() - t0;
  const out = (r.stdout || '') + (r.stderr || '');
  const timedOut = r.error && r.error.code === 'ETIMEDOUT';
  // last "CHECKS: N passed, M failed" wins
  const matches = [...out.matchAll(/CHECKS:\s*(\d+)\s+passed,\s*(\d+)\s+failed/g)];
  const last = matches.at(-1);
  const passed = last ? +last[1] : 0;
  const failed = last ? +last[2] : 0;
  // pass = clean exit AND a CHECKS line with 0 failed
  const passOk = !timedOut && r.status === 0 && last && failed === 0;
  return { passed, failed, ms, passOk, timedOut, hadChecks: !!last, out };
}

const rows = [];
let anyFailed = false;

for (const file of suites) {
  const name = file.replace(/\.mjs$/, '');
  process.stdout.write(`▶ ${name} … `);
  let res = runOnce(file);
  let status, note = '';
  if (res.passOk) {
    status = 'PASS';
  } else {
    // retry once
    process.stdout.write('failed, retrying once … ');
    const retry = runOnce(file);
    if (retry.passOk) {
      status = 'FLAKY';
      note = 'passed on retry';
      res = retry; // report retry's (green) counts
    } else {
      status = 'FAILED';
      anyFailed = true;
      note = res.timedOut || retry.timedOut ? 'timed out'
        : !res.hadChecks ? 'no CHECKS line (crash?)'
        : `${res.failed} check(s) failed`;
      res = retry;
    }
  }
  rows.push({ name, passed: res.passed, failed: res.failed, ms: res.ms, status, note });
  console.log(status + (note ? ` (${note})` : ''));
}

// ---- summary table ----
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const W = { name: Math.max(6, ...rows.map(r => r.name.length)), pass: 6, fail: 6, dur: 8, stat: 6 };
const line = '─'.repeat(W.name + W.pass + W.fail + W.dur + W.stat + 13);
console.log('\n' + line);
console.log(`│ ${pad('SUITE', W.name)} │ ${lpad('PASS', W.pass)} │ ${lpad('FAIL', W.fail)} │ ${lpad('TIME', W.dur)} │ ${pad('STATUS', W.stat)} │`);
console.log(line);
for (const r of rows) {
  console.log(`│ ${pad(r.name, W.name)} │ ${lpad(r.passed, W.pass)} │ ${lpad(r.failed, W.fail)} │ ${lpad((r.ms / 1000).toFixed(1) + 's', W.dur)} │ ${pad(r.status, W.stat)} │`
    + (r.note && r.status !== 'PASS' ? `  ${r.note}` : ''));
}
console.log(line);

const totals = rows.reduce((a, r) => ({ p: a.p + r.passed, f: a.f + r.failed, ms: a.ms + r.ms }), { p: 0, f: 0, ms: 0 });
const flaky = rows.filter(r => r.status === 'FLAKY').length;
const failed = rows.filter(r => r.status === 'FAILED').length;
console.log(`\n${rows.length} suites · ${totals.p} checks passed · ${totals.f} failed · ${flaky} flaky · ${failed} FAILED · ${(totals.ms / 1000).toFixed(1)}s total`);

process.exit(anyFailed ? 1 : 0);
