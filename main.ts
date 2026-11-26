import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { workspaceAlias, type MachineConnection, type WorkspaceActive } from '@lengmoxxl/sdk';
import type { MainContext } from '@lengmoxxl/sdk/channel';
import type { Machine, TerminalView } from './shared';

export const keys = { '<leader>t': { global: true, insert: true, desc: '打开终端视图', event: 'core:show-view', data: { plugin: 'terminal' } } };

// Which fields this plugin takes from init.ts, and the default each one falls back to.
export const config = {
  font: {
    family: { type: 'string', default: 'Menlo, monospace' },
    size: { type: 'number', default: 13 },
    lineHeight: { type: 'number', default: 1 },
  },
};

// The grid a shell is created with, which the pane then fits to the surface it draws on.
const initialSize = { rows: 24, cols: 80 };

// One shell of a tab: the session it reads now, what the bar calls it, and where a shell replacing a dead one is opened.
interface Shell { session: string; title: string; cwd: string }
// What the plugin keeps of a workspace between runs: the machine its terminals sit on, the name the node knows the
// workspace by, and every shell it holds.
interface TerminalTab { machine: Machine; name: string; shells: Shell[] }

export async function activate(context: MainContext) {
  // What this plugin keeps between runs: a record per file, read once and written back whole.
  function record<T>(name: string, empty: T) {
    const file = join(context.host.dataDirectory, name);
    const value = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as T : empty;
    const save = () => {
      writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
      renameSync(`${file}.tmp`, file);
    };
    return { value, save };
  }

  const terminals = record<Record<string, TerminalTab>>('sessions.json', {});
  // The last shell number handed out in each workspace: numbers only grow, so a closed shell's number is not reused.
  const numbers = record<Record<string, number>>('numbers.json', {});
  const connections = new Map<string, MachineConnection>();
  const homes = new Map<string, Promise<string>>();
  const handlers: (() => void)[] = [];
  const key = (machine: Machine) => machine.host ?? machine.id;

  async function connection(machine: Machine) {
    const existing = connections.get(key(machine));
    if (existing) return existing;
    const node = await context.connect(machine);
    connections.set(key(machine), node);
    return node;
  }

  async function location(machine: Machine, node: MachineConnection, cwd: string) {
    let home = homes.get(key(machine));
    if (!home) {
      home = node.subprocess.exec('/bin/sh', ['-c', 'printf %s "$HOME"'], { cwd: '/' })
        .then((result) => result.code === 0 ? Buffer.from(result.stdout).toString().trim() : '')
        .catch(() => '');
      homes.set(key(machine), home);
    }
    return cwd === await home ? '~' : basename(cwd) || '/';
  }

  // The tab as the window draws it: every shell of the workspace, named and placed.
  async function view(workspaceId: string): Promise<TerminalView> {
    const tab = tabOf(workspaceId);
    const node = await connection(tab.machine);
    const live = new Set((await node.pty.list()).filter((item) => item.exit_code === null).map((item) => item.id));
    // A shell that died while the app was closed is replaced by one opened where it was, under the name it has.
    for (const shell of tab.shells) {
      if (!live.has(shell.session)) shell.session = (await node.pty.create(initialSize, { cwd: shell.cwd, label: labelOf(tab, shell.title) })).id;
    }
    terminals.save();
    return {
      machine: tab.machine,
      workspaceId,
      sessions: await Promise.all(tab.shells.map(async (shell) => ({
        sessionId: shell.session,
        title: shell.title,
        location: await location(tab.machine, node, await node.pty.cwd(shell.session)),
      }))),
    };
  }

  function tabOf(workspaceId: string) {
    const tab = terminals.value[workspaceId];
    if (!tab) throw new Error('这个终端已经找不到了');
    return tab;
  }

  function nextTitle(workspaceId: string) {
    const number = (numbers.value[workspaceId] ?? 0) + 1;
    numbers.value[workspaceId] = number;
    numbers.save();
    return `t${number}`;
  }

  // The bar calls a shell by its number; the node's own list names the workspace it belongs to as well.
  const labelOf = (tab: TerminalTab, title: string) => `${tab.name} - ${title}`;

  // A shell opened where the workspace's own terminal sits, added to the tab that workspace keeps.
  async function add(active: WorkspaceActive) {
    const node = await connection(active.machine);
    const cwd = await context.request<string>(workspaceAlias, 'cwd', { workspaceId: active.workspaceId });
    const tab = terminals.value[active.workspaceId] ??= { machine: active.machine, name: active.name, shells: [] };
    const title = nextTitle(active.workspaceId);
    const session = await node.pty.create(initialSize, { cwd, label: labelOf(tab, title) });
    tab.shells.push({ session: session.id, title, cwd });
    terminals.save();
  }

  handlers.push(context.ui.handle('open', async (active: WorkspaceActive) => {
    if (!terminals.value[active.workspaceId]?.shells.length) await add(active);
    return view(active.workspaceId);
  }));
  handlers.push(context.ui.handle('create', async (active: WorkspaceActive) => {
    await add(active);
    return view(active.workspaceId);
  }));
  handlers.push(context.ui.handle('describe', (workspaceId: string) => view(workspaceId)));
  handlers.push(context.ui.handle('address', (workspaceId: string) => {
    const node = connections.get(key(tabOf(workspaceId).machine));
    if (!node) throw new Error('Machine is not connected');
    return `ws://localhost:${node.port}`;
  }));
  handlers.push(context.ui.handle('rename', ({ workspaceId, sessionId, title }: { workspaceId: string; sessionId: string; title: string }) => {
    const shell = tabOf(workspaceId).shells.find((item) => item.session === sessionId);
    if (!shell) throw new Error('这个终端已经找不到了');
    shell.title = title;
    terminals.save();
  }));
  // One shell goes and the tab stays for the others; the last one takes the tab's own entry with it.
  handlers.push(context.ui.handle('kill', async ({ workspaceId, sessionId }: { workspaceId: string; sessionId: string }) => {
    const tab = tabOf(workspaceId);
    tab.shells = tab.shells.filter((shell) => shell.session !== sessionId);
    if (!tab.shells.length) delete terminals.value[workspaceId];
    terminals.save();
    try { await (await connection(tab.machine)).pty.close(sessionId); } catch { /* the session is gone either way */ }
  }));
  handlers.push(context.ui.handle('close', async (workspaceId: string) => {
    const tab = tabOf(workspaceId);
    delete terminals.value[workspaceId];
    terminals.save();
    const node = await connection(tab.machine);
    await Promise.all(tab.shells.map((shell) => node.pty.close(shell.session).catch(() => { /* the session is gone either way */ })));
  }));

  return () => {
    for (const remove of handlers) remove();
    for (const node of connections.values()) node.disconnect();
  };
}
