import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { expandApplicationHtml } from '../build/application-html.js';
import { readStylesheet } from './testSupport/readStylesheet.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const html = expandApplicationHtml(read('index.html'));
const css = readStylesheet(path.join(ROOT, 'style.css'));
const panelChrome = read('src/ui/panelChrome.js');
const layoutController = read('src/ui/panelLayoutController.js');
const panelCss = read('src/ui/styles/street-level.css');
const controls = read('src/ui/streetLevelControls.js');

test('Street Level is an ordinary collapsible GEV panel that starts collapsed', () => {
  assert.match(
    html,
    /<div id="street-level-panel" class="panel-collapsible collapsed" data-panel-id="street-level-panel">/,
  );
  assert.match(
    html,
    /<button class="panel-collapse-btn" data-collapse-target="street-level-panel"/,
  );
  assert.match(html, /<span class="panel-title">STREET LEVEL<\/span>/);
  // Provider-neutral header: no vendor mark; the inner restores its scroll.
  assert.doesNotMatch(html, /sl-mark|mly-mark/);
  assert.match(
    html,
    /<div class="street-level-panel-inner" data-rail-scroller>/,
  );
  assert.doesNotMatch(
    html,
    /mapillary-dock|sl-minimized|sl-3d-btn|sl-photoreal-btn/,
  );
});

test('the panel is registered with panel chrome, cockpit entry and the right rail', () => {
  assert.match(panelChrome, /\{ id: 'street-level-panel' \}/);
  assert.match(
    panelChrome,
    /COCKPIT_ENTRY_COLLAPSE_PANEL_IDS = Object\.freeze\(\[[\s\S]*'street-level-panel'/,
  );
  assert.match(
    panelChrome,
    /const isRightRail = \[[\s\S]*'street-level-panel'/,
  );
  // The layout controller moves every rail panel in one loop; ours is listed.
  assert.match(
    layoutController,
    /for \(const panel of \[[\s\S]*?this\._streetLevelPanel,[\s\S]*?\]\) \{[\s\S]*?stack\.insertBefore\(panel, globalContextPanel\)/,
  );
  for (const rule of [
    '#right-context-rail > #street-level-panel',
    '#right-context-rail #street-level-panel.collapsed',
    '#right-context-rail.layout-focus > #street-level-panel:not(.collapsed)',
  ])
    assert.ok(css.includes(rule), `layers.css names ${rule}`);
});

test('panel styles stay inside GEV conventions: no !important, no fixed panel', () => {
  assert.equal((panelCss.match(/!important/g) || []).length, 0);
  const fixed = panelCss
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('}')
    .filter((block) => /position:\s*fixed/.test(block))
    .map((block) => block.slice(0, block.indexOf('{')).trim());
  assert.deepEqual(fixed, ['.sl-viewer-wrap-expanded']);
});

test('the keyless state gates the controls rather than leaving dead buttons', () => {
  // The key requirement is documented (README, .env.example), not repeated in the panel.
  assert.doesNotMatch(
    html,
    /sl-keyless|sl-query|sl-results|data-sl-suggestion/,
  );
  assert.match(html, /<fieldset id="sl-controls"/);
  assert.match(html, /<div id="sl-provider-chips" class="sl-chips"><\/div>/);
  assert.match(html, /<select id="sl-since"[\s\S]*?value="3652"/);
  assert.doesNotMatch(html, /value="year:/);
  assert.match(html, /<ul id="sl-legend"/);
  assert.match(html, /id="sl-error"[^>]*role="alert"/);
  assert.match(html, /id="sl-status"[^>]*role="status"/);
});

test('the expanded viewer is a modal dialog that restores focus', () => {
  assert.match(controls, /setAttribute\('role', 'dialog'\)/);
  assert.match(controls, /setAttribute\('aria-modal', 'true'\)/);
  assert.match(controls, /_expandReturnFocus/);
});

test('labels say what the buttons do', () => {
  for (const label of [
    'OPEN NEAREST PHOTO',
    'CAMERA FOLLOWS VIEW',
    'PROVIDERS',
  ])
    assert.ok(html.includes(label), label);
  assert.doesNotMatch(
    html,
    /LOOK HERE|STREET COCKPIT|>FRAME<|ZOOM TO RESULTS|ASK IN PLAIN ENGLISH/,
  );
});
