const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { openMachine } = require('@lengmoxxl/sdk');
const { ACTIVE_TERMINAL, closeView, createWorkspace, openView, until, wangcaiApp, withHome, withWindow } = require('@lengmoxxl/wangcai-testkit');

// The plugins these cases drive, every panel of this one, hidden ones included, and that panel as the window shows it.
const lists = { workspaces: ['terminal-agent'], tabs: ['files', 'terminal'] };
const panel = '.sidebar-panel[data-plugin=terminal]';
const shown = `${panel}:visible`;

// The workspace rows the window draws, in their order.
const tabs = (page) => page.getByRole('tablist', { name: '工作区', exact: true }).getByRole('tab');

// What this view's terminal panel has drawn, which is where a typed line shows up.
const drawn = (page) => page.locator(`${panel} .xterm-rows`).textContent();

// A pane drops input while it is between attachments, so the line is typed again until the shell answers.
const typeUntil = (page, scope, command, observed) => until(observed, {
  act: async () => {
    await page.locator(`${scope} .xterm-helper-textarea`).click();
    await page.keyboard.type(command);
    await page.keyboard.press('Enter');
  },
});

test('the terminal view opens its own shell in the sidebar, reattaches it and kills it when closed', { timeout: 180000 }, () => withHome('wangcai-terminal', lists, async ({ home, open }) => {
  const binary = join(wangcaiApp(), 'wangcaicli/dist/debug/wangcai');
  const directory = join(home, '示例 project');
  const sessionsPath = join(home, '.local/share/wangcai/data/terminal/sessions.json');
  const onlySession = () => Object.keys(JSON.parse(readFileSync(sessionsPath, 'utf8')))[0];
  // The SDK reads server.json from the home it is told, which is this case's own node, not the one a dev run left.
  const machine = () => openMachine({ type: 'local', binary, env: { HOME: home } });
  mkdirSync(directory);

  let { page, close } = await open();
  await openView(page, '终端');
  const notice = page.locator(`${panel} .terminal-message`);
  await notice.waitFor();
  assert.equal(await notice.textContent(), '请先打开一个工作区终端', 'without a workspace terminal the view explains itself');
  await closeView(page);

  await createWorkspace(page);
  const workspaceSession = await page.evaluate(async () => (await window.wangcai.call('request', 'terminal-agent', 'config')).workspaces[0].sessionId);
  await typeUntil(page, ACTIVE_TERMINAL, `cd '${directory}'`, async () => (await tabs(page).filter({ hasText: '示例 project' }).count()) > 0);

  await openView(page, '终端');
  await page.locator(shown).waitFor();
  assert.equal(await page.locator(shown).getAttribute('aria-label'), '示例 project - t1', 'the tab is named after the workspace and its first tab');
  const terminalSession = onlySession();
  assert.notEqual(terminalSession, workspaceSession, 'the view opens a shell of its own');
  await typeUntil(page, shown, 'printf "TERM_PWD=%s\\n" "$PWD"', async () => (await drawn(page)).includes(`TERM_PWD=${directory}`));
  await close();

  ({ page, close } = await open());
  await until(async () => (await drawn(page)).includes('TERM_PWD'));

  await close();
  const node = await machine();
  await node.pty.close(terminalSession);
  node.disconnect();
  ({ page, close } = await open());
  const failure = page.locator(`${panel} .terminal-message`);
  await failure.waitFor();
  assert.match(await failure.textContent(), /Terminal no longer exists/, 'a shell that died while the app was closed is reported');
  await closeView(page);

  await openView(page, '终端');
  await page.locator(shown).waitFor();
  assert.equal(await page.locator(shown).getAttribute('aria-label'), '示例 project - t2', 'the workspace is used again, and its numbers only grow');
  const reopenedSession = onlySession();
  await typeUntil(page, shown, 'printf "RESTORED_PWD=%s\\n" "$PWD"', async () => (await drawn(page)).includes(`RESTORED_PWD=${directory}`));
  await closeView(page);
  // Closing the tab is what takes the session out of the plugin's own book, which is why the call that describes it
  // rejects; the node's list, waited for next, is the layer below, where the shell itself is gone.
  await until(() => page.evaluate(async (sessionId) => { try { await window.wangcai.call('request', 'terminal', 'describe', sessionId); return false; } catch { return true; } }, reopenedSession));
  await until(async () => {
    const node = await machine();
    const list = await node.pty.list();
    node.disconnect();
    return list.every((session) => session.id !== reopenedSession);
  });
  await close();

  ({ page, close } = await open());
  await tabs(page).first().waitFor();
  assert.equal(await page.locator(panel).count(), 0, 'a closed tab is not restored');
}));

test('what a program in the terminal copies reaches the system clipboard', { timeout: 180000 }, () => withWindow('wangcai-terminal-clipboard', lists, async ({ page }) => {
  const text = 'OSC52_COPY_ME';
  // What a program copies with: an OSC 52 sequence, which the shell prints for it here.
  const sequence = `\\033]52;c;${Buffer.from(text).toString('base64')}\\007`;
  await createWorkspace(page);
  await openView(page, '终端');
  await page.locator(shown).waitFor();
  // The clipboard is the machine's, so it is told apart from what the same test copied before.
  await page.evaluate(() => navigator.clipboard.writeText('not copied yet'));
  await typeUntil(page, shown, `printf '${sequence}'`, async () => (await page.evaluate(() => navigator.clipboard.readText())) === text);
}));

test('a printed web address is a link the app opens in a browser', { timeout: 180000 }, () => withHome('wangcai-terminal-links', lists, async ({ open }) => {
  const { desktop, page } = await open();
  // The window hands a link to the system browser: the test takes that call instead.
  await desktop.evaluate(({ shell }) => { shell.openExternal = async (url) => { globalThis.opened = url; }; });
  // An address longer than the pane is wide, so it prints across a wrap.
  const address = `https://example.com/${'a-very-long-address-segment/'.repeat(7)}page.html`;
  // What the rows say, and the part of each a link underlines: both come off one read of the drawn rows.
  const rowsOf = () => page.evaluate((selector) => [...document.querySelectorAll(`${selector} .xterm-rows > div`)].map((row) => ({
    text: row.textContent,
    link: [...row.querySelectorAll('span')].filter((span) => span.style.textDecoration === 'underline').map((span) => span.textContent).join(''),
  })), panel);
  const underlined = async () => (await rowsOf()).map(({ link }) => link);
  // The point one character of a row sits at, which is where a pointer goes to touch that cell.
  const point = (row, at) => page.evaluate(({ selector, row, at }) => {
    const element = document.querySelectorAll(`${selector} .xterm-rows > div`)[row];
    let skip = at;
    for (const span of element.querySelectorAll('span')) {
      if (skip >= span.firstChild.length) { skip -= span.firstChild.length; continue; }
      const range = document.createRange();
      range.setStart(span.firstChild, skip);
      range.setEnd(span.firstChild, skip + 1);
      const rect = range.getBoundingClientRect();
      return [rect.left + rect.width / 2, rect.top + rect.height / 2];
    }
    throw new Error(`row ${row} is shorter than ${at + 1} characters`);
  }, { selector: panel, row, at });

  await createWorkspace(page);
  await openView(page, '终端');
  await page.locator(shown).waitFor();
  await typeUntil(page, shown, `clear; stty -echo; printf '%s\\n' '${address}'`, async () => (await drawn(page)).includes(address.slice(-12)));
  const printed = (await rowsOf()).map(({ text }) => text);
  const last = printed.findLastIndex((row) => row.includes(address.slice(-16)));
  assert.notEqual(last, -1, `no row holds the end of the address: ${JSON.stringify(printed)}`);
  let first = last;
  while (first > 0 && printed[first - 1] && address.includes(printed[first - 1])) first--;
  assert.ok(last > first, 'the printed address wraps');

  const covered = Array.from({ length: last - first + 1 }, (_, at) => first + at);
  // The pointer finds the address as a link on every row the wrap put it on, and every row is hovered again on each
  // round, because the app answers a row when the pointer comes back to it.
  await until(async () => {
    const links = (await underlined()).map((text) => Boolean(text));
    return covered.every((at) => links[at]);
  }, {
    act: async () => {
      for (const row of covered) {
        const [x, y] = await point(row, 1);
        await page.mouse.move(0, 0);
        await page.mouse.move(x, y);
      }
    },
  });
  assert.deepEqual((await underlined()).map((text, row) => (text ? row : -1)).filter((row) => row >= 0), covered, 'the address is one link on every row it covers');
  assert.equal((await underlined()).join(''), address, 'the link is the whole address');

  // The click that holds Command is what opens the address.
  const [x, y] = await point(first, 1);
  await page.keyboard.down('Meta');
  await page.mouse.click(x, y);
  let opened;
  await until(async () => (opened = await desktop.evaluate(() => globalThis.opened)) !== undefined);
  assert.equal(opened, address, 'the app is handed the address');

  await page.keyboard.up('Meta');
  await desktop.evaluate(() => { globalThis.opened = undefined; });
  await page.mouse.click(x, y);
  // The click reaches the app either way; what this gives it is the time to have taken it and opened nothing, which is
  // the only way a refusal can show.
  await page.waitForTimeout(500);
  assert.equal(await desktop.evaluate(() => globalThis.opened), undefined, 'a click that holds no Command opens nothing');
}));

test('a pane attaches again when the socket to the node drops', { timeout: 180000 }, () => withWindow('wangcai-terminal-socket', lists, async ({ page }) => {
  await createWorkspace(page);
  // A slept laptop or a dropped tunnel takes the pane's own socket with it, so the test holds the
  // sockets the pane opens and closes the one it is reading from.
  await page.evaluate(() => {
    const Native = window.WebSocket;
    window.__sockets = [];
    window.WebSocket = class extends Native {
      constructor(url) { super(url); window.__sockets.push(this); }
    };
  });
  await openView(page, '终端');
  await page.locator(shown).waitFor();
  await typeUntil(page, shown, "printf 'BEFORE_DROP_%s\\n' ok", async () => (await drawn(page)).includes('BEFORE_DROP_ok'));
  assert.equal(await page.evaluate(() => window.__sockets.length), 1, 'the pane reads from a socket of its own');
  await page.evaluate(() => window.__sockets.at(-1).close());
  await until(() => page.evaluate(() => window.__sockets.length === 2));
  await typeUntil(page, shown, "printf 'AFTER_DROP_%s\\n' ok", async () => (await drawn(page)).includes('AFTER_DROP_ok'));
  assert.equal(await page.locator(`${panel} .terminal-message.error`).count(), 0, 'a recovered pane says nothing about the drop');
}));
