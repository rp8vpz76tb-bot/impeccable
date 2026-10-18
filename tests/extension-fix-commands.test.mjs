import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const panel = readFileSync(path.join(ROOT, 'extension/devtools/panel.js'), 'utf8');
const registry = JSON.parse(readFileSync(path.join(ROOT, 'crates/live/assets/antipatterns.json'), 'utf8'));
const fixMap = new Function(`return (${panel.match(/const FIX_COMMANDS = (\{[\s\S]*?\n\});/)[1]})`)();
const commands = new Set(
  readdirSync(path.join(ROOT, 'skill/reference'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -3)),
);

describe('extension panel fix commands', () => {
  it('maps every registry rule', () => {
    const missing = registry.filter((r) => !fixMap[r.id]).map((r) => r.id);
    assert.deepEqual(missing, [], 'rules without a fix command; add them to FIX_COMMANDS in extension/devtools/panel.js');
  });

  it('names no rule the registry does not have', () => {
    const ids = new Set(registry.map((r) => r.id));
    assert.deepEqual(Object.keys(fixMap).filter((id) => !ids.has(id)), []);
  });

  it('only suggests commands that have a reference file', () => {
    const bad = [...new Set(Object.values(fixMap).flat())].filter((c) => !commands.has(c));
    assert.deepEqual(bad, []);
  });

  it('prints commands as /impeccable <command>', () => {
    assert.match(panel, /'\/impeccable ' \+ c/);
    assert.doesNotMatch(panel, /'\/' \+ s/);
  });
});
