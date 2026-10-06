const { existsSync, mkdirSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

/**
 * The WangCai checkout next to this repository, which runs this plugin. It has to be built: the app
 * launches in place and loads this plugin's files from this directory. A missing one is an error
 * rather than a skip, because every test here drives the app.
 */
exports.wangcaiApp = () => {
  const root = resolve(__dirname, '../../WangCai');
  const built = ['desktop/dist/main/index.js', 'desktop/node/bin/node', 'wangcaicli/dist/debug/wangcai'];
  if (!built.every((name) => existsSync(join(root, name)))) throw new Error('build the WangCai checkout next to this repository');
  return root;
};

/** Launches that checkout on this home, with the Electron the checkout depends on. */
exports.launchApp = (home, env) => {
  const app = exports.wangcaiApp();
  const { _electron: electron } = require(join(app, 'node_modules/playwright'));
  return electron.launch({ executablePath: require(join(app, 'node_modules/electron')), args: [join(app, 'desktop'), `--user-data-dir=${join(home, 'electron')}`], cwd: app, env });
};

/** A plugin checkout next to this one, already built into the files the app loads. */
const checkout = (id) => {
  const directory = resolve(__dirname, `../../WangCai-${id}`);
  return existsSync(join(directory, 'main.cjs')) ? directory : undefined;
};

/** The app loads only what init.ts lists, so a test names the plugins and where to read them from. */
exports.writeInit = (home, lists) => {
  const { workspaces = [], tabs = [] } = lists ?? { workspaces: ['terminal-agent'], tabs: ['files', 'terminal'] };
  const entry = (item) => {
    const spec = typeof item === 'string' ? { id: item } : item;
    if (!spec.directory && !spec.repo) {
      const directory = checkout(spec.id);
      if (directory) spec.directory = directory;
    }
    return JSON.stringify(spec);
  };
  const list = (entries) => entries.map(entry).join(', ');
  mkdirSync(join(home, '.config/wangcai'), { recursive: true });
  writeFileSync(join(home, '.config/wangcai/init.ts'), `export default { workspaces: [${list(workspaces)}], tabs: [${list(tabs)}] };\n`);
};

exports.waitForShell = (page) => page.locator('.workspaces').waitFor();

/** A right-click on the workspace heading opens the menu of machines a workspace can be opened on. */
const openWorkspaceMenu = (page) => page.locator('.workspace-header').click({ button: 'right' });

/** Waits until the workspace in front has a terminal that takes input; a session id alone is not enough. */
const waitForTerminal = async (page) => {
  const id = await page.evaluate(async () => {
    const config = await window.wangcai.request('terminal-agent', 'config');
    return config.workspaces.find((workspace) => workspace.id === config.active)?.sessionId;
  });
  for (let attempt = 0; attempt < 400; attempt++) {
    const attached = await page.evaluate((session) => window.wangcai.request('terminal-agent', 'pty', { op: 'input', sessionId: session, params: { data: '' } }).then(() => true, () => false), id);
    if (attached) return;
    await page.waitForTimeout(50);
  }
  throw new Error('the terminal never attached');
};

/** The list menu offers one entry per machine; picking the local one opens a workspace on it. */
exports.createWorkspace = async (page) => {
  await openWorkspaceMenu(page);
  await page.locator('#workspace-row-menu').getByRole('menuitem', { name: '本机', exact: true }).click();
  await page.locator('.terminal-pane.active .xterm-helper-textarea').waitFor();
  await waitForTerminal(page);
};
