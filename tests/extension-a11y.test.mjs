import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(ROOT, 'extension', file), 'utf8');

const CSS = ['shared/kinpaku.css', 'devtools/panel.css', 'devtools/sidebar.css', 'popup/popup.css'];

describe('extension accessibility floor', () => {
  it('keeps every functional font size at or above the 11px micro step', () => {
    for (const file of CSS) {
      const small = [...read(file).matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].filter((m) => Number(m[1]) < 11);
      assert.deepEqual(small.map((m) => m[0]), [], `${file} has text below 11px`);
    }
  });

  it('draws the focus ring in patina-deep, which clears 3:1 on paper', () => {
    const kit = read('shared/kinpaku.css');
    assert.match(kit, /:focus-visible\s*\{\s*outline:\s*2px solid var\(--ks-patina-deep\)/);
    assert.doesNotMatch(read('devtools/panel.css'), /outline:\s*2px solid var\(--ks-patina\)/);
  });

  it('never uses the faint tokens for read text in the panel list', () => {
    const panel = read('devtools/panel.css');
    for (const selector of ['.group-count', '.finding-copy']) {
      const block = panel.match(new RegExp(`\\n${selector.replace('.', '\\.')} \\{[^}]*\\}`))[0];
      assert.doesNotMatch(block, /text-faint|mute-deep/, `${selector} reads as text`);
    }
  });

  it('honors reduced motion and forced colors', () => {
    const kit = read('shared/kinpaku.css');
    assert.match(kit, /prefers-reduced-motion: reduce\)\s*\{\s*:root\s*\{[^}]*--ks-quick:\s*0ms/);
    for (const file of ['shared/kinpaku.css', 'devtools/panel.css', 'popup/popup.css']) {
      assert.match(read(file), /forced-colors: active/, `${file} has no forced-colors rules`);
    }
  });

  it('builds the findings list from real buttons, not click-handler divs', () => {
    const panel = read('devtools/panel.js');
    assert.match(panel, /<button type="button" class="group-toggle" aria-expanded/);
    assert.match(panel, /class="finding-selector finding-inspect"/);
    assert.doesNotMatch(panel, /header\.className = 'group-header';[\s\S]{0,200}header\.addEventListener\('click'/);
  });

  it('exposes toggle state and names on the panel controls', () => {
    const html = read('devtools/panel.html');
    assert.match(html, /id="btn-toggle"[^>]*aria-pressed/);
    assert.match(html, /id="btn-settings"[^>]*aria-expanded/);
    assert.match(html, /id="auto-scan-mode" role="group"/);
    assert.match(html, /id="spotlight-blur-toggle" aria-labelledby/);
  });

  it('keeps Undo reachable after a rule is muted', () => {
    const panel = read('devtools/panel.js');
    assert.match(panel, /function offerUndo/);
    assert.match(panel, /toastTimer = setTimeout\(hideToast, 8000\)/);
  });
});
