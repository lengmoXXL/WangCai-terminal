// What a case does to the window's own chrome, and the selectors for this plugin's panes: shared by every case here so
// opening a workspace or a view has one implementation.

/** The plugins these cases drive. */
const lists = { workspaces: ['terminal-agent'], tabs: ['files', 'terminal'] };

// The menu that makes a workspace is the space under the rows: the rows have to end above the list's bottom edge, so the
// click lands on the list rather than on a row.
const openWorkspaceMenu = async (page) => {
  const list = page.locator('.workspaces');
  const box = await list.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 4, { button: 'right' });
};

/** The terminal of the workspace in front: the app's own pane, not a plugin's panel. */
const ACTIVE_TERMINAL = '.terminal-pane.active';
const activeTerminal = (page) => page.locator(ACTIVE_TERMINAL);

/** Waits until the terminal in front draws that text, which it does once the shell has written it. */
const terminalShows = (page, text) => activeTerminal(page).locator('.xterm-screen').filter({ hasText: text }).waitFor();

/** Opens a local workspace, and waits for the shell its pane draws a moment after the workspace appears. */
const createWorkspace = async (page) => {
  await openWorkspaceMenu(page);
  await page.locator('#workspace-row-menu').getByRole('menuitem', { name: '新建 本机', exact: true }).click();
  await terminalShows(page, /\S/);
};

/** Opens a view in the sidebar, showing the sidebar first when it is off screen. */
const openView = async (page, name) => {
  const newTab = page.getByRole('button', { name: '新建侧栏标签页' });
  if (!(await newTab.isVisible())) await page.getByRole('button', { name: '切换右侧栏' }).click();
  await newTab.click();
  await page.locator('#view-menu').getByRole('button', { name, exact: true }).click();
};

/** Closes the sidebar tab that is selected. */
const closeView = (page) => page.locator('.sidebar-tab:has([aria-selected=true]) .close-tab').click();

// Every panel of this plugin, hidden ones included, and that panel as the window shows it.
const panel = '.sidebar-panel[data-plugin=terminal]';
const shown = `${panel}:visible`;
/** The pane of the shell the sidebar tab has in front. */
const frontPane = `${shown} .terminal-pane:not([hidden])`;

module.exports = { lists, ACTIVE_TERMINAL, createWorkspace, openView, closeView, panel, shown, frontPane };
