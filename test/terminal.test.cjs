const { test } = require('node:test');
const assert = require('node:assert/strict');
const { connect } = require('@lengmoxxl/sdk');
const { mkdtempSync, mkdirSync, readFileSync, rmSync, realpathSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');
const { createWorkspace, launchApp, testEnv, waitForShell, wangcaiApp, writeInit } = require('./harness.cjs');

/** The checkout next to this repository, which these tests drive. */
const app = wangcaiApp();

test('the terminal view opens its own shell in the sidebar, reattaches it and kills it when closed', { timeout: 180000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-terminal-')));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  process.env.WANGCAI_HOME = '';
  const env = testEnv(home);
  const binary = join(app, 'wangcaicli/dist/debug/wangcai');
  const directory = join(home, '示例 project');
  const store = join(home, '.local/share/wangcai/data/terminal/sessions.json');
  const record = () => Object.keys(JSON.parse(readFileSync(store, 'utf8')))[0];
  const sessions = async () => {
    const node = await connect({ type: 'local', binary });
    const list = await node.pty.list();
    node.disconnect();
    return list;
  };
  let desktop;
  const launch = async () => {
    desktop = await launchApp(home, env);
    const page = await desktop.firstWindow();
    await waitForShell(page);
    return page;
  };
  const openView = async (page, name) => {
    if (!await page.locator('.sidebar-right').isVisible()) await page.getByRole('button', { name: '切换右侧栏' }).click();
    await page.getByRole('button', { name: '新建侧栏标签页' }).click();
    await page.locator('#view-menu').getByRole('button', { name, exact: true }).click();
  };
  // A pane drops input while it is between attachments, so retry until the shell answers.
  const typeUntil = async (page, textarea, command, observed) => {
    for (let attempt = 0; attempt < 30 && !await observed(); attempt++) {
      await page.locator(textarea).click();
      await page.keyboard.type(command);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(200);
    }
    assert.ok(await observed(), `the shell never answered: ${command}`);
  };
  try {
    writeInit(home);
    mkdirSync(directory);
    let page = await launch();
    await openView(page, '终端');
    const notice = page.locator('.sidebar-panel[data-plugin=terminal]:visible .terminal-message');
    await notice.waitFor();
    assert.equal(await notice.textContent(), '请先打开一个工作区终端', 'without a workspace terminal the view explains itself');
    await page.getByRole('button', { name: '关闭 终端' }).click();

    await createWorkspace(page);
    const workspaceSession = await page.evaluate(async () => (await window.wangcai.request('terminal-agent', 'config')).workspaces[0].sessionId);
    await typeUntil(page, '.terminal-pane.active .xterm-helper-textarea', `cd '${directory}'`, async () => await page.getByRole('tablist', { name: '工作区', exact: true }).getByRole('tab').filter({ hasText: '示例 project' }).count() > 0);

    await openView(page, '终端');
    const panel = '.sidebar-panel[data-plugin=terminal]:visible';
    await page.locator(panel).waitFor();
    assert.equal(await page.locator(panel).getAttribute('aria-label'), '示例 project', 'the tab is named after the directory the shell starts in');
    const terminalSession = record();
    assert.notEqual(terminalSession, workspaceSession, 'the view opens a shell of its own');
    await typeUntil(page, `${panel} .xterm-helper-textarea`, 'printf "TERM_PWD=%s\\n" "$PWD"', async () => (await page.locator(`${panel} .xterm-rows`).textContent()).includes(`TERM_PWD=${directory}`));
    await desktop.close(); desktop = undefined;

    page = await launch();
    await page.locator('.sidebar-panel[data-plugin=terminal] .xterm-rows').filter({ hasText: 'TERM_PWD' }).waitFor();

    await desktop.close(); desktop = undefined;
    const node = await connect({ type: 'local', binary });
    await node.pty.close(terminalSession);
    node.disconnect();
    page = await launch();
    const failure = page.locator('.sidebar-panel[data-plugin=terminal] .terminal-message');
    await failure.waitFor();
    assert.match(await failure.textContent(), /Terminal no longer exists/, 'a shell that died while the app was closed is reported');
    await page.getByRole('button', { name: '关闭 终端' }).click();

    await openView(page, '终端');
    await page.locator(panel).waitFor();
    assert.equal(await page.locator(panel).getAttribute('aria-label'), '示例 project', 'the same directory is used again');
    const reopenedSession = record();
    await typeUntil(page, `${panel} .xterm-helper-textarea`, 'printf "RESTORED_PWD=%s\\n" "$PWD"', async () => (await page.locator(`${panel} .xterm-rows`).textContent()).includes(`RESTORED_PWD=${directory}`));
    await page.getByRole('button', { name: '关闭 示例 project' }).click();
    await page.waitForFunction(async (sessionId) => { try { await window.wangcai.request('terminal', 'describe', sessionId); return false; } catch { return true; } }, reopenedSession);
    let killed = false;
    for (let attempt = 0; attempt < 50 && !killed; attempt++) {
      killed = (await sessions()).every((session) => session.id !== reopenedSession);
      if (!killed) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(killed, 'closing the tab kills the shell');
    await desktop.close(); desktop = undefined;

    page = await launch();
    await page.getByRole('tablist', { name: '工作区', exact: true }).getByRole('tab').waitFor();
    assert.equal(await page.locator('.sidebar-panel[data-plugin=terminal]').count(), 0, 'a closed tab is not restored');
  } finally {
    await desktop?.close();
    process.env.HOME = previousHome;
    // The app leaves its node running when it quits, and the store that names it goes with the home below.
    try { execFileSync(binary, ['server', 'stop'], { env, stdio: 'ignore', timeout: 15000 }); } catch {}
    rmSync(home, { recursive: true, force: true });
  }
});
