/* size-guard.mjs — structural regression guard for the extraction track.
 *
 * Four extraction prompts took index.html from 989,257 B to ~79,887 B by moving
 * CSS to css/, JS to js/, and guide screenshots to img/guide/. Nothing else stops
 * it silently regrowing: a pasted-back function, a re-inlined <style>, or an
 * inlined base64 image would undo the work and NO behavioural test would fail.
 * This guard is that missing test. It reads files only — it never launches a
 * browser — and prints the same `CHECKS:` / `ERRORS:` lines every other suite
 * prints so the unified runner can parse it uniformly.
 *
 * Every threshold lives in CONFIG below with the reason it exists. If this guard
 * fails, the fix is almost always to move code back out — NOT to raise the limit.
 * Raise a number only when the repo has legitimately, permanently grown, and say
 * why in the same commit.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

const CONFIG = {
  // index.html is now shell-only (head + body DOM + link/script tags), ~79.9 KB.
  // 120 KB leaves headroom for honest markup growth but trips well before a
  // re-inlined stylesheet (~177 KB) or script block (~404 KB) could land.
  INDEX_MAX_BYTES: 120_000,
  // Largest js/ file is ~64 KB (03-assets-ops). 90 KB catches a big paste-back
  // while tolerating normal edits; if a file legitimately needs more, split it.
  JS_FILE_MAX_BYTES: 90_000,
  // Largest css/ file is ~108 KB (03-app.css). 120 KB is deliberately just above
  // it — a real regression (merging files, re-inlining) blows past this fast.
  CSS_FILE_MAX_BYTES: 120_000,
  // The head has small, legitimate inline scripts (theme-before-paint, logoFail).
  // Anything larger than 2 KB inline means application code moved back into the
  // shell instead of into js/.
  INLINE_SCRIPT_MAX_BYTES: 2_000,
  // A base64 image data URI over 5 KB is an inlined asset — it belongs in img/.
  // The two tiny inline SVG utf-8 URIs (not base64) and the attachment-render
  // template strings (`data:' + a.media + ';base64,' + a.data`) are NOT literal
  // image URIs and must not trip this.
  BASE64_URI_MAX_BYTES: 5_000,
};

let ok = 0, fail = 0;
const fails = [];
function check(pass, msg) { if (pass) { ok++; } else { fail++; fails.push(msg); } }

const bytes = (s) => Buffer.byteLength(s, 'utf8');
const read = (rel) => readFileSync(join(REPO, rel), 'utf8');
const index = read('index.html');

// ---- 1. index.html total size ----
{
  const n = bytes(index);
  check(n <= CONFIG.INDEX_MAX_BYTES,
    `index.html is ${n} B, over the ${CONFIG.INDEX_MAX_BYTES} B limit. ` +
    `WHY: index.html must stay a thin shell — CSS lives in css/, JS in js/, images in img/. ` +
    `A size like this means code was pasted back in. Move it back out; do not raise the limit.`);
}

// ---- 2. each js/ file size ----
for (const f of readdirSync(join(REPO, 'js')).filter(f => f.endsWith('.js')).sort()) {
  const n = bytes(read('js/' + f));
  check(n <= CONFIG.JS_FILE_MAX_BYTES,
    `js/${f} is ${n} B, over the ${CONFIG.JS_FILE_MAX_BYTES} B per-file limit. ` +
    `WHY: the JS is deliberately split into ~8 files so any one is greppable. ` +
    `If it grew this large, a large block landed in the wrong file — split it at a banner seam.`);
}

// ---- 3. each css/ file size ----
for (const f of readdirSync(join(REPO, 'css')).filter(f => f.endsWith('.css')).sort()) {
  const n = bytes(read('css/' + f));
  check(n <= CONFIG.CSS_FILE_MAX_BYTES,
    `css/${f} is ${n} B, over the ${CONFIG.CSS_FILE_MAX_BYTES} B per-file limit. ` +
    `WHY: the stylesheet is split into 6 files (03-app.css ~108 KB is the largest). ` +
    `Exceeding this means files were merged or a <style> block was re-inlined.`);
}

// ---- 4. no <style> block in index.html ----
{
  const hasStyle = /<style[\s>]/i.test(index);
  check(!hasStyle,
    `index.html contains a <style> block. ` +
    `WHY: all CSS was extracted to css/ (6 order-dependent files). A <style> block ` +
    `means CSS moved back inline — move it into the right css/ file instead.`);
}

// ---- 5. inline <script> (no src) content under the limit ----
{
  const inlineScripts = [...index.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  let worst = 0, count = 0;
  for (const m of inlineScripts) { const n = bytes(m[1]); count++; if (n > worst) worst = n; }
  check(worst <= CONFIG.INLINE_SCRIPT_MAX_BYTES,
    `index.html has an inline <script> with ${worst} B of content, over the ` +
    `${CONFIG.INLINE_SCRIPT_MAX_BYTES} B limit (${count} inline scripts total). ` +
    `WHY: application JS lives in js/ as classic scripts. Only tiny head scripts ` +
    `(theme-before-paint, logoFail) may stay inline. A large one means code moved back in.`);
}

// ---- 6. no oversized base64 image data URI in any tracked file ----
{
  const targets = ['index.html',
    ...readdirSync(join(REPO, 'js')).filter(f => f.endsWith('.js')).map(f => 'js/' + f),
    ...readdirSync(join(REPO, 'css')).filter(f => f.endsWith('.css')).map(f => 'css/' + f)];
  const re = /data:image\/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/=]+)/g;
  const hits = [];
  for (const rel of targets) {
    const src = read(rel);
    for (const m of src.matchAll(re)) {
      const len = m[1].length;
      if (len > CONFIG.BASE64_URI_MAX_BYTES) hits.push(`${rel} (${len} B payload)`);
    }
  }
  check(hits.length === 0,
    `Oversized base64 image data URI found: ${hits.join(', ')}. ` +
    `WHY: inlined images belong in img/ as real files (the 12 guide shots were ` +
    `extracted for exactly this reason). Over ${CONFIG.BASE64_URI_MAX_BYTES} B means an ` +
    `asset was pasted back inline — save it to img/ and reference it by path.`);
}

// ---- 7. no script tag in index.html uses type=module / defer / async ----
{
  const bad = [];
  for (const m of index.matchAll(/<script\b[^>]*>/gi)) {
    const tag = m[0];
    if (/\btype\s*=\s*["']?module\b/i.test(tag)) bad.push('type="module"');
    if (/\bdefer\b/i.test(tag)) bad.push('defer');
    if (/\basync\b/i.test(tag)) bad.push('async');
  }
  check(bad.length === 0,
    `index.html has a script tag using: ${[...new Set(bad)].join(', ')}. ` +
    `WHY: the js/ files are classic scripts sharing one global scope, executed in ` +
    `order synchronously. type="module" gives each its own scope (breaks the global ` +
    `graph); defer/async change execution timing. None are allowed.`);
}

// ---- 8. css links and js scripts are in strict numeric order ----
{
  const cssLinks = [...index.matchAll(/href="css\/(\d+)-[a-z0-9-]+\.css"/g)].map(m => +m[1]);
  const jsScripts = [...index.matchAll(/src="js\/(\d+)-[a-z0-9-]+\.js"/g)].map(m => +m[1]);
  const strictlyIncreasing = (a) => a.every((v, i) => i === 0 || v > a[i - 1]);
  check(cssLinks.length > 0 && strictlyIncreasing(cssLinks),
    `css/ <link> tags are not in strict numeric order: [${cssLinks.join(', ')}]. ` +
    `WHY: CSS cascade order is load-bearing (a later rule overriding an earlier one ` +
    `has bitten this repo twice). The links must load 01 -> NN in order.`);
  check(jsScripts.length > 0 && strictlyIncreasing(jsScripts),
    `js/ <script> tags are not in strict numeric order: [${jsScripts.join(', ')}]. ` +
    `WHY: the js/ files share one global scope with no import graph; a later file may ` +
    `read a const from an earlier one but not vice-versa. They must load 01 -> NN in order.`);
}

if (fails.length) {
  console.log('\nSIZE-GUARD FAILURES:');
  for (const f of fails) console.log('  ✗ ' + f + '\n');
}
console.log(`CHECKS: ${ok} passed, ${fail} failed`);
console.log(fail ? 'ERRORS: PRESENT' : 'ERRORS: NONE');
if (fail) process.exitCode = 1;
