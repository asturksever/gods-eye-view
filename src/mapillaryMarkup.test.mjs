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
const mapillaryCss = read('src/ui/styles/mapillary.css');
const controls = read('src/ui/mapillaryControls.js');

test('Street Level is an ordinary collapsible GEV panel that starts collapsed', () => {
  assert.match(
    html,
    /<div id="mapillary-panel" class="panel-collapsible collapsed" data-panel-id="mapillary-panel">/,
  );
  assert.match(
    html,
    /<button class="panel-collapse-btn" data-collapse-target="mapillary-panel"/,
  );
  assert.match(html, /<span class="panel-title">STREET LEVEL<\/span>/);
  assert.match(html, /<svg class="mly-mark"/);
  assert.doesNotMatch(html, /mapillary-dock|mly-minimized/);
});

test('the panel is registered with panel chrome, cockpit entry and the right rail', () => {
  assert.match(panelChrome, /\{ id: 'mapillary-panel' \}/);
  assert.match(
    panelChrome,
    /COCKPIT_ENTRY_COLLAPSE_PANEL_IDS = Object\.freeze\(\[[\s\S]*'mapillary-panel'/,
  );
  assert.match(panelChrome, /const isRightRail = \[[\s\S]*'mapillary-panel'/);
  assert.match(
    layoutController,
    /stack\.insertBefore\(this\._mapillaryPanel, globalContextPanel\)/,
  );
  // The showcase branch guards rail rules with :not(.panel-floating).
  const guard = '(?::not\\(\\.panel-floating\\))?';
  for (const rule of [
    `#right-context-rail > #mapillary-panel${guard}[,{ ]`,
    `#right-context-rail #mapillary-panel\\.collapsed${guard}[,{ ]`,
    `#right-context-rail\\.layout-focus\\s*>\\s*#mapillary-panel:not\\(\\.collapsed\\)${guard}[,{ ]`,
  ])
    assert.match(css, new RegExp(rule), `layers.css names ${rule}`);
});

test('panel styles stay inside GEV conventions: no !important, no fixed panel', () => {
  assert.equal((mapillaryCss.match(/!important/g) || []).length, 0);
  const fixed = mapillaryCss
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('}')
    .filter((block) => /position:\s*fixed/.test(block))
    .map((block) => block.slice(0, block.indexOf('{')).trim());
  assert.deepEqual(fixed, ['.mly-viewer-wrap-expanded']);
});

test('keyless and no-planner states are real, gated UI rather than dead buttons', () => {
  assert.match(html, /id="mly-keyless"[^>]*hidden/);
  assert.match(html, /MAPILLARY_CLIENT_TOKEN/);
  assert.match(html, /<fieldset id="mly-controls"/);
  assert.match(html, /<ul id="mly-legend"/);
  assert.match(html, /id="mly-error"[^>]*role="alert"/);
  assert.match(html, /id="mly-status"[^>]*role="status"/);
});

test('the expanded viewer is a modal dialog that restores focus', () => {
  assert.match(controls, /setAttribute\('role', 'dialog'\)/);
  assert.match(controls, /setAttribute\('aria-modal', 'true'\)/);
  assert.match(controls, /_expandReturnFocus/);
  assert.match(
    controls,
    /if \(event\.key !== 'Escape'\) event\.stopPropagation\(\);/,
  );
});

test('labels say what the buttons do', () => {
  for (const label of [
    'OPEN NEAREST PHOTO',
    'CAMERA FOLLOWS VIEW',
    'ZOOM TO RESULTS',
  ])
    assert.ok(html.includes(label), label);
  assert.doesNotMatch(html, /LOOK HERE|STREET COCKPIT|>FRAME</);
});
