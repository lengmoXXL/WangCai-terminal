const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { openMachine } = require('@lengmoxxl/sdk');
const { Terminal } = require('@xterm/headless');
const { ACTIVE_TERMINAL, closeView, createWorkspace, openView, until, wangcaiApp, withHome, withWindow } = require('@lengmoxxl/wangcai-testkit');

// The plugins these cases drive, every panel of this one, hidden ones included, and that panel as the window shows it.
const lists = { workspaces: ['terminal-agent'], tabs: ['files', 'terminal'] };
const panel = '.sidebar-panel[data-plugin=terminal]';
const shown = `${panel}:visible`;

// The workspace rows the window draws, in their order.
const tabs = (page) => page.getByRole('tablist', { name: '工作区', exact: true }).getByRole('tab');

// The shell the plugin's own book holds for this home: one it was never asked to close stays in the book, so the
// newest entry is the shell the pane is reading.
const newestSession = (home) => Object.keys(JSON.parse(readFileSync(join(home, '.local/share/wangcai/data/terminal/sessions.json'), 'utf8'))).at(-1);

const binary = join(wangcaiApp(), 'wangcaicli/dist/debug/wangcai');

// The pane draws its rows on a canvas, which tells a test nothing, so its text is read off the stream the node sends
// it and parsed into a terminal of the size the pane held at the attach. A case that turns cells into points waits for
// the pane to hold still first: a grid the pane outgrows puts the points a case works out on other cells.
const watch = async (test, home, sessionId) => {
  const node = await openMachine({ type: 'local', binary, env: { HOME: home } });
  // The rows are read off buffer.active, which xterm hands out only with the proposed API allowed.
  const terminal = new Terminal({ cols: 80, rows: 24, scrollback: 10_000, allowProposedApi: true });
  const pty = await node.pty.attach(sessionId);
  pty.onSnapshot((snapshot) => { terminal.reset(); terminal.resize(snapshot.cols, snapshot.rows); terminal.write(snapshot.data); });
  pty.onData((output) => terminal.write(output.data));
  const rows = () => Array.from({ length: terminal.buffer.active.length }, (_, y) => terminal.buffer.active.getLine(y)?.translateToString(true) ?? '');
  const close = () => { node.disconnect(); terminal.dispose(); };
  test.after(close);
  // A reading is of one run of the node: a connection that drops is not chased again, which is what keeps a case
  // that failed halfway from holding the run open.
  node.onState((state) => { if (state.status === 'connecting') close(); });
  return {
    rows,
    // What it printed, its rows run together the way a line the pane wrapped runs on into the next one.
    text: () => rows().join(''),
    size: () => ({ cols: terminal.cols, rows: terminal.rows }),
  };
};

// A pane drops input while it is between attachments, so the line is typed again until the shell answers.
const typeUntil = (page, scope, command, observed) => until(observed, {
  act: async () => {
    await page.locator(`${scope} .xterm-helper-textarea`).click();
    await page.keyboard.type(command);
    await page.keyboard.press('Enter');
  },
});

test('the terminal view opens its own shell in the sidebar, reattaches it and kills it when closed', { timeout: 180000 }, (test) => withHome('wangcai-terminal', lists, async ({ home, open }) => {
  const directory = join(home, '示例 project');
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
  const terminalSession = newestSession(home);
  assert.notEqual(terminalSession, workspaceSession, 'the view opens a shell of its own');
  const view = await watch(test, home, terminalSession);
  await typeUntil(page, shown, 'printf "TERM_PWD=%s\\n" "$PWD"', () => view.text().includes(`TERM_PWD=${directory}`));
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
  const reopenedSession = newestSession(home);
  const restored = await watch(test, home, reopenedSession);
  await typeUntil(page, shown, 'printf "RESTORED_PWD=%s\\n" "$PWD"', () => restored.text().includes(`RESTORED_PWD=${directory}`));
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

test('a printed web address is a link the app opens in a browser', { timeout: 180000 }, (test) => withHome('wangcai-terminal-links', lists, async ({ home, open }) => {
  const { desktop, page } = await open();
  // The window hands a link to the system browser: the test takes that call instead.
  await desktop.evaluate(({ shell }) => { shell.openExternal = async (url) => { globalThis.opened = url; }; });
  // An address longer than the pane is wide, so it prints across a wrap.
  const address = `https://example.com/${'a-very-long-address-segment/'.repeat(7)}page.html`;

  await createWorkspace(page);
  await openView(page, '终端');
  await page.locator(shown).waitFor();
  // A click is what waits for the pane's box to hold still; waiting for it to be visible is not.
  await page.locator(`${shown} .xterm-helper-textarea`).click();
  const view = await watch(test, home, newestSession(home));
  await typeUntil(page, shown, `clear; stty -echo; printf '%s\\n' '${address}'`, () => view.text().includes(address.slice(-12)));
  const printed = await view.rows();
  const last = printed.findLastIndex((row) => row.includes(address.slice(-16)));
  assert.notEqual(last, -1, `no row holds the end of the address: ${JSON.stringify(printed.filter(Boolean))}`);
  let first = last;
  while (first > 0 && printed[first - 1] && address.includes(printed[first - 1])) first--;
  assert.ok(last > first, 'the printed address wraps');

  const screen = await page.locator(`${panel} .xterm-screen`).boundingBox();
  const { cols, rows } = view.size();
  // The buffer holds the scrollback too, and the pane shows the last rows of it.
  const top = printed.length - rows;
  // The point one character of a row sits at, from the size the pane drew its cells at.
  const point = (row, at) => [screen.x + (screen.width / cols) * (at + 0.5), screen.y + (screen.height / rows) * (row - top + 0.5)];
  // The pane answers a link with the cursor, and answers on entering a row rather than on staying in it.
  const answers = async (row, at) => {
    const [x, y] = point(row, at);
    await page.mouse.move(0, 0);
    await page.mouse.move(x, y);
    // The pane answers the move a frame later, not within the move itself.
    await page.waitForTimeout(80);
    return (await page.locator('.xterm-cursor-pointer').count()) > 0;
  };

  // Every row the wrap put the address on answers the pointer, and a cell past its end does not: the link is those
  // rows, not more.
  await until(async () => {
    for (let row = first; row <= last; row++) if (!(await answers(row, 1))) return false;
    return !(await answers(last + 1, cols - 1));
  });

  await page.keyboard.down('Meta');
  // The click that holds Command is what opens the address.
  const [x, y] = point(first, 1);
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

test('a pane attaches again when the socket to the node drops', { timeout: 180000 }, (test) => withWindow('wangcai-terminal-socket', lists, async ({ home, page }) => {
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
  const view = await watch(test, home, newestSession(home));
  await typeUntil(page, shown, "printf 'BEFORE_DROP_%s\\n' ok", () => view.text().includes('BEFORE_DROP_ok'));
  assert.equal(await page.evaluate(() => window.__sockets.length), 1, 'the pane reads from a socket of its own');
  await page.evaluate(() => window.__sockets.at(-1).close());
  await until(() => page.evaluate(() => window.__sockets.length === 2));
  await typeUntil(page, shown, "printf 'AFTER_DROP_%s\\n' ok", () => view.text().includes('AFTER_DROP_ok'));
  assert.equal(await page.locator(`${panel} .terminal-message.error`).count(), 0, 'a recovered pane says nothing about the drop');
}));

test('the view takes the keys when its own key brings it forward', { timeout: 180000 }, (test) => withHome('wangcai-terminal-keys', lists, async ({ home, open }) => {
  const { page } = await open();
  await createWorkspace(page);
  await openView(page, '终端');
  await page.locator(shown).waitFor();
  const view = await watch(test, home, newestSession(home));
  await until(() => view.text().includes('$'));
  // The keys are elsewhere: the page has them, not the pane the key is about to bring forward.
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  for (const key of ['Space', 't', 't']) await page.keyboard.press(key);
  // Nothing is clicked between the key and the typing: showing the view is what put the keys in it.
  await page.keyboard.type("printf 'KEYS_%s\\n' ok");
  await page.keyboard.press('Enter');
  await until(() => view.text().includes('KEYS_ok'));
}));
