import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { MachineConnection, WorkspaceActive } from '@lengmoxxl/sdk';
import type { MainContext } from '@lengmoxxl/sdk/channel';
import type { Machine, TerminalRef } from './shared';

export const keys = { '<leader>t': { global: true, insert: true, desc: '打开终端视图', event: 'core:show-view', data: { plugin: 'terminal' } } };

// Which fields this plugin takes from init.ts, and the default each one falls back to.
export const config = {
  font: {
    family: { type: 'string', default: '"DejaVuSansM Nerd Font Mono", monospace' },
    size: { type: 'number', default: 13 },
    lineHeight: { type: 'number', default: 1 },
  },
};

// The grid a shell is created with, which the pane then fits to the surface it draws on.
const initialSize = { rows: 24, cols: 80 };

// What the plugin keeps of one tab between runs: the machine it sits on, the shell it reads now, and what a shell
// replacing a dead one is opened with.
interface TerminalTab { machine: Machine; session: string; title: string; cwd: string }

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

  const terminals = record<Record<string, TerminalTab>>('terminals.json', {});
  // The last tab number handed out in each workspace: numbers only grow, so a closed tab's number is not reused.
  const tabs = record<Record<string, number>>('tabs.json', {});
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

  async function ref(id: string, tab: TerminalTab, node: MachineConnection, cwd: string): Promise<TerminalRef> {
    return {
      machine: tab.machine,
      tabId: id,
      sessionId: tab.session,
      title: tab.title,
      location: await location(tab.machine, node, cwd),
    };
  }

  function tabOf(id: string) {
    const tab = terminals.value[id];
    if (!tab) throw new Error('这个终端已经找不到了');
    return tab;
  }

  function nextTitle(active: WorkspaceActive) {
    const number = (tabs.value[active.workspaceId] ?? 0) + 1;
    tabs.value[active.workspaceId] = number;
    tabs.save();
    return `${active.name} - t${number}`;
  }

  handlers.push(context.ui.handle('open', async (active: WorkspaceActive) => {
    const node = await connection(active.machine);
    const cwd = await node.pty.cwd(active.sessionId);
    const title = nextTitle(active);
    const session = await node.pty.create(initialSize, { cwd, label: title });
    const tab = { machine: active.machine, session: session.id, title, cwd };
    terminals.value[session.id] = tab;
    terminals.save();
    return ref(session.id, tab, node, cwd);
  }));
  handlers.push(context.ui.handle('describe', async (id: string) => {
    const tab = tabOf(id);
    const node = await connection(tab.machine);
    const live = (await node.pty.list()).find((item) => item.id === tab.session && item.exit_code === null);
    // A shell that died while the app was closed is replaced by one opened where the tab was, under the name it has.
    if (!live) {
      const session = await node.pty.create(initialSize, { cwd: tab.cwd, label: tab.title });
      tab.session = session.id;
      terminals.save();
      return ref(id, tab, node, tab.cwd);
    }
    return ref(id, tab, node, await node.pty.cwd(live.id));
  }));
  handlers.push(context.ui.handle('address', (id: string) => {
    const node = connections.get(key(tabOf(id).machine));
    if (!node) throw new Error('Machine is not connected');
    return `ws://localhost:${node.port}`;
  }));
  handlers.push(context.ui.handle('close', async (id: string) => {
    const tab = tabOf(id);
    delete terminals.value[id];
    terminals.save();
    try { await (await connection(tab.machine)).pty.close(tab.session); } catch { /* the session is gone either way */ }
  }));

  return () => {
    for (const remove of handlers) remove();
    for (const node of connections.values()) node.disconnect();
  };
}
