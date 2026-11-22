const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lists, createWorkspace, openView, frontPane } = require('./terminal-ui.cjs');
const { until, withWindow } = require('@lengmoxxl/wangcai-testkit');

// xterm writes the theme's background inline on the viewport, which is the one surface that carries it under either
// renderer: the glyphs themselves go to a canvas when the WebGL addon loads.
const painted = (page) => page.locator(frontPane).locator('.xterm-viewport').evaluate((viewport) => ({
  background: getComputedStyle(viewport).backgroundColor,
  scheme: document.documentElement.style.colorScheme,
}));

const switchTo = async (page, name) => {
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+Space');
  await page.keyboard.press('u');
  await page.keyboard.press('t');
  await page.locator('.prompt-scrim:not([hidden])').waitFor();
  await page.locator('.prompt-list button', { hasText: name }).first().click();
  await page.locator('.prompt-scrim').waitFor({ state: 'hidden' });
};

test('a switch of theme recolours the sidebar shell already on screen', { timeout: 180000 }, () => withWindow('wangcai-terminal-theme', lists, async ({ page, errors }) => {
  await createWorkspace(page);
  await openView(page, '终端');
  await until(async () => (await painted(page)).scheme === 'dark');
  const dark = await painted(page);
  assert.equal(dark.background, 'rgb(25, 26, 27)', 'the terminal is painted in the dark background');

  await switchTo(page, 'GitHub');
  await until(async () => (await painted(page)).scheme === 'light');
  assert.equal((await painted(page)).background, 'rgb(255, 255, 255)', 'the grid already on screen took GitHub background');

  await switchTo(page, 'WangCai');
  await until(async () => (await painted(page)).scheme === 'dark');
  assert.equal((await painted(page)).background, dark.background, 'switching back restores the background');
  assert.deepEqual(errors, []);
}));
