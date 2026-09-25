#!/usr/bin/env node
/**
 * Browser QA for the Street Level (Mapillary) layer against a running dev
 * server: the panel's place in the right rail, the keyless gate, coverage,
 * a ready-made feature plan (no LLM), the embedded viewer and its expanded
 * dialog. Run with `npm run qa:mapillary -- --url http://localhost:4173`.
 * Without MAPILLARY_CLIENT_TOKEN on the server only the keyless steps run.
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

/** Viewports every layout assertion runs at. */
export const VIEWPORTS = Object.freeze([
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
]);

/** A feature plan the executor can run without the planner. */
export function hydrantPlan() {
  return {
    intent: 'map_features',
    layer: 'points',
    place: null,
    use_current_view: true,
    values: ['object--fire-hydrant'],
    seen_after: null,
    seen_before: null,
    prefer_pano: false,
    visualise: 'icons',
    title: 'Fire hydrants · current view',
    answer: 'Showing fire hydrants in the current view.',
  };
}

/** Expected right-rail order once the layout controller has run. */
export const RAIL_ORDER = Object.freeze([
  'pp-toggles',
  'cctv-panel',
  'weather-panel',
  'recent-imagery-panel',
  'mapillary-panel',
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
      window.__godsEyeView.dataManager.layers.get('mapillary').module;
    const panel = () =>
      page.evaluate(() => {
        const el = document.getElementById('mapillary-panel');
        const rail = document.getElementById('right-context-rail');
        const box = el.getBoundingClientRect();
        return {
          order: rail ? [...rail.children].map((child) => child.id) : [],
          classes: [...el.classList],
          width: Math.round(box.width),
          right: Math.round(box.right),
          status: document.getElementById('mly-status').textContent,
          controlsDisabled: document.getElementById('mly-controls').disabled,
          bodyDisplay: getComputedStyle(document.getElementById('mly-body'))
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
      '.panel-collapse-btn[data-collapse-target="mapillary-panel"]',
    );
    await sleep(500);
    await step(
      'expanding the strip shows the body and the four-swatch legend',
      async () => {
        const info = await panel();
        assert.ok(!isCollapsed(info.classes));
        assert.equal(info.bodyDisplay, 'flex');
        assert.equal(
          await page.evaluate(
            () => document.querySelectorAll('#mly-legend li').length,
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
            window.__godsEyeView.dataManager.setEnabled('mapillary', true, {
              origin: 'user',
            }),
          );
          await sleep(800);
          const info = await panel();
          assert.equal(info.controlsDisabled, true);
          assert.equal(info.status, 'KEY REQUIRED');
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
          window.__godsEyeView.dataManager.setEnabled('mapillary', true, {
            origin: 'user',
          }),
        );
        await page.waitForFunction(
          () => {
            const u = window.__godsEyeView.dataManager.layers
              .get('mapillary')
              .module.getUIState();
            return u.coverage.sequences > 0 && !u.coverage.loading;
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
    await step(
      'a ready-made plan streams results and fills the chips',
      async () => {
        // Fire and forget: the fan-out can outlive a CDP call, so poll instead.
        await page.evaluate((plan) => {
          void window.__godsEyeView.dataManager.layers
            .get('mapillary')
            .module.runPlan(plan, { prompt: 'fire hydrants here' });
        }, hydrantPlan());
        await sleep(500);
        await page.waitForFunction(
          () =>
            !window.__godsEyeView.dataManager.layers
              .get('mapillary')
              .module.getUIState().query.busy,
          { timeout: 120_000 },
        );
        const state = await page.evaluate(() => {
          const u = window.__godsEyeView.dataManager.layers
            .get('mapillary')
            .module.getUIState();
          return {
            total: u.features.total,
            answer: u.query.answer,
            chips: document.querySelectorAll(
              '#mly-result-chips .mly-value-chip',
            ).length,
          };
        });
        assert.ok(state.total > 0, 'hydrants found in view');
        assert.match(state.answer, /fire hydrants?/i);
        assert.ok(state.chips >= 1);
      },
    );
    await step(
      'opening the nearest image shows the viewer with a caption',
      async () => {
        await page.evaluate(() =>
          window.__godsEyeView.dataManager.layers
            .get('mapillary')
            .module.openNearest(),
        );
        await page.waitForFunction(
          () => {
            const s = window.__godsEyeView.dataManager.layers
              .get('mapillary')
              .module.getUIState().street;
            return s.imageId || s.error;
          },
          { timeout: 90_000 },
        );
        const street = await page.evaluate(
          () =>
            window.__godsEyeView.dataManager.layers
              .get('mapillary')
              .module.getUIState().street,
        );
        assert.equal(street.error, null, `viewer error: ${street.error}`);
        // Some images carry no creator name; the date/bearing side always fills.
        try {
          await page.waitForFunction(
            () =>
              document.getElementById('mly-image-when').textContent.trim()
                .length > 0,
            { timeout: 30_000 },
          );
        } catch (error) {
          const dump = await page.evaluate(() => {
            const u = window.__godsEyeView.dataManager.layers
              .get('mapillary')
              .module.getUIState();
            return {
              street: u.street,
              wrapHidden: document.getElementById('mly-viewer-wrap').hidden,
              collapsed: document
                .getElementById('mapillary-panel')
                .classList.contains('collapsed'),
            };
          });
          throw new Error(
            `caption never filled: ${JSON.stringify(dump)}; errors=${JSON.stringify(errors)}`,
            { cause: error },
          );
        }
        const view = await page.evaluate(() => ({
          hidden: document.getElementById('mly-viewer-wrap').hidden,
          when: document.getElementById('mly-image-when').textContent.trim(),
          width: Math.round(
            document.getElementById('mly-viewer').getBoundingClientRect().width,
          ),
        }));
        assert.equal(view.hidden, false);
        assert.ok(view.width > 200);
        assert.ok(view.when.length > 0, 'caption shows the capture date');
      },
    );
    await step(
      'EXPAND opens a modal dialog and Esc returns focus to the button',
      async () => {
        await page.click('#mly-viewer-expand');
        await sleep(600);
        const dialog = await page.evaluate(() => {
          const wrap = document.getElementById('mly-viewer-wrap');
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
                .getElementById('mly-viewer-wrap')
                .classList.contains('mly-viewer-wrap-expanded'),
              focus: document.activeElement?.id,
            }))
            .then((r) => `${r.expanded}:${r.focus}`),
          'false:mly-viewer-expand',
        );
      },
    );
    await step('× closes the image and deselects it on the globe', async () => {
      await page.click('#mly-viewer-close');
      await sleep(500);
      const after = await page.evaluate(() => {
        const u = window.__godsEyeView.dataManager.layers
          .get('mapillary')
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
