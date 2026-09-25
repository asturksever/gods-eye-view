#!/usr/bin/env node
/**
 * Browser QA for the Street Level layer against a running dev
 * server: the panel's place in the right rail, the provider chips, the
 * keyless gate, coverage and its credit, switching a provider off and on,
 * the imagery filter, the embedded viewer and its expanded dialog. Run with `npm run qa:street-level -- --url http://localhost:4173`.
 * Without MAPILLARY_CLIENT_TOKEN on the server only the keyless steps run.
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

/** Viewports every layout assertion runs at. */
export const VIEWPORTS = Object.freeze([
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
]);

/** Provider chips the panel must show, in order (one per registered provider). */
export const EXPECTED_PROVIDERS = Object.freeze(['mapillary']);

/** Expected right-rail order once the layout controller has run. */
export const RAIL_ORDER = Object.freeze([
  'pp-toggles',
  'cctv-panel',
  'weather-panel',
  'recent-imagery-panel',
  'street-level-panel',
  'global-context-panel',
]);

export function isCollapsed(classList) {
  return [...classList].includes('collapsed');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const { default: puppeteer } = await import('puppeteer');
  const args = process.argv.slice(2);
  const urlIndex = args.indexOf('--url');
  const url = urlIndex >= 0 ? args[urlIndex + 1] : 'http://localhost:4173';
  const browser = await puppeteer.launch({
    headless: true,
    executablePath:
      process.env.PUPPETEER_EXECUTABLE_PATH ||
      (await puppeteer.executablePath()),
    defaultViewport: VIEWPORTS[0],
    protocolTimeout: 300_000,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'],
  });
  let passed = 0;
  const step = async (label, fn) => {
    const result = await fn();
    passed++;
    console.log(`ok ${passed} ${label}`);
    return result;
  };
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    // The layer swallows listener exceptions into a console warning; surface them.
    page.on('console', (message) => {
      if (/listener error/i.test(message.text())) errors.push(message.text());
    });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => Boolean(window.__godsEyeView?.dataManager),
      {
        timeout: 150_000,
      },
    );
    await page.evaluate(() =>
      document.querySelector('.first-run-explore')?.click(),
    );
    await sleep(800);
    await page.keyboard.press('Escape');
    await sleep(400);
    await page.evaluate(() => {
      for (const el of document.querySelectorAll(
        '#first-run-launcher, [class*=first-run]',
      ))
        el.remove();
    });
    const module = () =>
      window.__godsEyeView.dataManager.layers.get('street-level').module;
    const panel = () =>
      page.evaluate(() => {
        const el = document.getElementById('street-level-panel');
        const rail = document.getElementById('right-context-rail');
        const box = el.getBoundingClientRect();
        return {
          order: rail ? [...rail.children].map((child) => child.id) : [],
          classes: [...el.classList],
          width: Math.round(box.width),
          right: Math.round(box.right),
          status: document.getElementById('sl-status').textContent,
          controlsDisabled: document.getElementById('sl-controls').disabled,
          bodyDisplay: getComputedStyle(document.getElementById('sl-body'))
            .display,
        };
      });
    const status = await page.evaluate(() =>
      fetch('/api/mapillary/status').then((res) => res.json()),
    );
    for (const viewport of VIEWPORTS) {
      await page.setViewport(viewport);
      await sleep(600);
      await step(
        `panel is a collapsed right-rail strip at ${viewport.width}×${viewport.height}`,
        async () => {
          const info = await panel();
          assert.deepEqual(info.order, RAIL_ORDER);
          assert.ok(isCollapsed(info.classes));
          assert.equal(info.bodyDisplay, 'none');
          assert.ok(info.width <= 200 && info.right <= viewport.width);
        },
      );
    }
    await page.setViewport(VIEWPORTS[0]);
    await page.click(
      '.panel-collapse-btn[data-collapse-target="street-level-panel"]',
    );
    await sleep(500);
    await step(
      'expanding the strip shows the body, one chip per provider and the legend',
      async () => {
        const info = await panel();
        assert.ok(!isCollapsed(info.classes));
        assert.equal(info.bodyDisplay, 'flex');
        const chips = await page.evaluate(() =>
          [
            ...document.querySelectorAll(
              '#sl-provider-chips .data-toggle-chip',
            ),
          ].map((chip) => chip.dataset.chipId),
        );
        assert.deepEqual(chips, EXPECTED_PROVIDERS);
        assert.equal(
          await page.evaluate(
            () => document.querySelectorAll('#sl-legend li').length,
          ),
          4,
        );
      },
    );
    if (!status.configured) {
      await step(
        'keyless install gates the controls and reports KEY REQUIRED',
        async () => {
          await page.evaluate(() =>
            window.__godsEyeView.dataManager.setEnabled('street-level', true, {
              origin: 'user',
            }),
          );
          await sleep(800);
          const info = await panel();
          assert.equal(info.controlsDisabled, true);
          assert.equal(info.status, 'KEY REQUIRED');
          assert.equal(
            await page.evaluate(() =>
              document
                .querySelector('#sl-provider-chips [data-chip-id="mapillary"]')
                .classList.contains('chip-error'),
            ),
            true,
            'the keyless provider chip reads as an error',
          );
        },
      );
      console.log(
        'keyless run complete (no MAPILLARY_CLIENT_TOKEN on the server)',
      );
      return;
    }
    // The startup flight can still be running: cancel it, park the camera over
    // downtown Sacramento and confirm it stays put before enabling the layer.
    const park = () =>
      page.evaluate(() => {
        const v = window.__godsEyeView.viewer;
        v.camera.cancelFlight?.();
        const C = v.camera.positionCartographic.constructor;
        v.camera.setView({
          destination: v.scene.globe.ellipsoid.cartographicToCartesian(
            C.fromDegrees(-121.4944, 38.5816, 900),
          ),
          orientation: { heading: 0, pitch: -1.3, roll: 0 },
        });
      });
    for (let attempt = 0; attempt < 6; attempt++) {
      await park();
      await sleep(1500);
      const stable = await page.evaluate(() => {
        const c = window.__godsEyeView.viewer.camera.positionCartographic;
        return Math.abs((c.longitude * 180) / Math.PI + 121.4944) < 0.01;
      });
      if (stable) break;
    }
    await step(
      'enabling draws coverage and registers the on-globe credit',
      async () => {
        await page.evaluate(() =>
          window.__godsEyeView.dataManager.setEnabled('street-level', true, {
            origin: 'user',
          }),
        );
        await page.waitForFunction(
          () => {
            const u = window.__godsEyeView.dataManager.layers
              .get('street-level')
              .module.getUIState();
            return u.coverage.count > 0 && !u.coverage.loading;
          },
          { timeout: 90_000 },
        );
        const info = await panel();
        assert.equal(info.controlsDisabled, false);
        // Cesium paints on-screen credits a frame or two after they register.
        await page.waitForFunction(
          () => document.body.innerHTML.includes('Mapillary</a> contributors'),
          { timeout: 15_000 },
        );
      },
    );
    const ui = () =>
      page.evaluate(() =>
        window.__godsEyeView.dataManager.layers
          .get('street-level')
          .module.getUIState(),
      );
    await step(
      'switching the provider chip off clears its coverage and credit',
      async () => {
        await page.click('#sl-provider-chips [data-chip-id="mapillary"]');
        await page.waitForFunction(
          () =>
            window.__godsEyeView.dataManager.layers
              .get('street-level')
              .module.getUIState().coverage.count === 0,
          { timeout: 15_000 },
        );
        const state = await ui();
        assert.equal(state.providers[0].on, false);
        assert.deepEqual(state.legend, [], 'no active provider, no legend');
        await page.waitForFunction(
          () => !document.body.innerHTML.includes('Mapillary</a> contributors'),
          { timeout: 15_000 },
        );
        assert.deepEqual(
          await page.evaluate(() =>
            window.__godsEyeView.dataManager.layers
              .get('street-level')
              .module.getParams(),
          ),
          { mapillary: false, pano: 'all', sinceDays: 0 },
        );
      },
    );
    await step('switching it back on restores coverage', async () => {
      await page.click('#sl-provider-chips [data-chip-id="mapillary"]');
      await page.waitForFunction(
        () => {
          const u = window.__godsEyeView.dataManager.layers
            .get('street-level')
            .module.getUIState();
          return u.coverage.count > 0 && !u.coverage.loading;
        },
        { timeout: 90_000 },
      );
      assert.equal((await ui()).providers[0].on, true);
    });
    await step(
      'the 360° filter keeps at most the unfiltered sequence count',
      async () => {
        const before = (await ui()).coverage.count;
        await page.click('[data-sl-pano="pano"]');
        await sleep(600);
        const after = (await ui()).coverage.count;
        assert.ok(after <= before, `${after} ≤ ${before}`);
        assert.equal((await ui()).filter.pano, 'pano');
        await page.click('[data-sl-pano="all"]');
        await sleep(600);
        assert.equal((await ui()).coverage.count, before);
      },
    );
    await step(
      'opening the nearest image shows the viewer with a caption',
      async () => {
        // Fire and forget: the open can outlive one CDP call, so poll instead.
        await page.evaluate(() => {
          void window.__godsEyeView.dataManager.layers
            .get('street-level')
            .module.openNearest();
        });
        await page.waitForFunction(
          () => {
            const s = window.__godsEyeView.dataManager.layers
              .get('street-level')
              .module.getUIState().street;
            return s.imageId || s.error;
          },
          { timeout: 90_000 },
        );
        const street = await page.evaluate(
          () =>
            window.__godsEyeView.dataManager.layers
              .get('street-level')
              .module.getUIState().street,
        );
        assert.equal(street.error, null, `viewer error: ${street.error}`);
        // Some images carry no creator name; the date/bearing side always fills.
        try {
          await page.waitForFunction(
            () =>
              document.getElementById('sl-image-when').textContent.trim()
                .length > 0,
            { timeout: 30_000 },
          );
        } catch (error) {
          const dump = await page.evaluate(() => {
            const u = window.__godsEyeView.dataManager.layers
              .get('street-level')
              .module.getUIState();
            return {
              street: u.street,
              wrapHidden: document.getElementById('sl-viewer-wrap').hidden,
              collapsed: document
                .getElementById('street-level-panel')
                .classList.contains('collapsed'),
            };
          });
          throw new Error(
            `caption never filled: ${JSON.stringify(dump)}; errors=${JSON.stringify(errors)}`,
            { cause: error },
          );
        }
        const view = await page.evaluate(() => ({
          hidden: document.getElementById('sl-viewer-wrap').hidden,
          when: document.getElementById('sl-image-when').textContent.trim(),
          link: document.getElementById('sl-image-link').textContent.trim(),
          href: document.getElementById('sl-image-link').href,
          width: Math.round(
            document.getElementById('sl-viewer').getBoundingClientRect().width,
          ),
        }));
        assert.equal(view.hidden, false);
        assert.ok(view.width > 200);
        assert.ok(view.when.length > 0, 'caption shows the capture date');
        assert.equal(street.providerId, 'mapillary');
        assert.equal(view.link, 'MAPILLARY ↗');
        assert.match(view.href, /mapillary\.com\/app\/\?pKey=/);
      },
    );
    await step(
      'EXPAND opens a modal dialog and Esc returns focus to the button',
      async () => {
        await page.click('#sl-viewer-expand');
        await sleep(600);
        const dialog = await page.evaluate(() => {
          const wrap = document.getElementById('sl-viewer-wrap');
          return {
            role: wrap.getAttribute('role'),
            modal: wrap.getAttribute('aria-modal'),
            inside: wrap.contains(document.activeElement),
            width: Math.round(wrap.getBoundingClientRect().width),
          };
        });
        assert.equal(dialog.role, 'dialog');
        assert.equal(dialog.modal, 'true');
        assert.equal(dialog.inside, true);
        assert.ok(dialog.width > 900);
        await page.keyboard.press('Escape');
        await sleep(400);
        assert.equal(
          await page
            .evaluate(() => ({
              expanded: document
                .getElementById('sl-viewer-wrap')
                .classList.contains('sl-viewer-wrap-expanded'),
              focus: document.activeElement?.id,
            }))
            .then((r) => `${r.expanded}:${r.focus}`),
          'false:sl-viewer-expand',
        );
      },
    );
    await step('× closes the image and deselects it on the globe', async () => {
      await page.click('#sl-viewer-close');
      await sleep(500);
      const after = await page.evaluate(() => {
        const u = window.__godsEyeView.dataManager.layers
          .get('street-level')
          .module.getUIState();
        return { open: u.street.open, sequence: u.sequence.selectedId };
      });
      assert.equal(after.open, false);
      assert.equal(after.sequence, null);
    });
    await step('no page errors', () => {
      assert.deepEqual(errors, []);
    });
    void module;
  } finally {
    await browser.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
