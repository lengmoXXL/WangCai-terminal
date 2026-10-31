import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { MachineConnection, Session, WorkspaceActive } from '@lengmoxxl/sdk';
import type { MainContext } from '@lengmoxxl/sdk/channel';
import type { Machine, TerminalRef } from './shared';

export const keys = { '<leader>tt': { global: true, desc: '打开终端视图', event: 'core:show-view', data: { plugin: 'terminal' } } };

// Which fields this plugin takes from init.ts, and the default each one falls back to.
export const config = {
  font: {
    family: { type: 'string', default: '"DejaVuSansM Nerd Font Mono", monospace' },
    size: { type: 'number', default: 13 },
    lineHeight: { type: 'number', default: 1 },
  },
};

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

  const sessions = record<Record<string, Machine>>('sessions.json', {});
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

  async function ref(machine: Machine, node: MachineConnection, session: Session, cwd: string): Promise<TerminalRef> {
    return {
      machine,
      sessionId: session.id,
      title: session.label ?? session.title,
      location: await location(machine, node, cwd),
    };
  }

  function machineOf(sessionId: string) {
    const machine = sessions.value[sessionId];
    if (!machine) throw new Error('这个终端已经找不到了');
    return machine;
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
    const session = await node.pty.create({ rows: 24, cols: 80 }, { cwd, label: title });
    sessions.value[session.id] = active.machine;
    sessions.save();
    return ref(active.machine, node, session, cwd);
  }));
  handlers.push(context.ui.handle('describe', async (sessionId: string) => {
    const machine = machineOf(sessionId);
    const node = await connection(machine);
    // The node is what says a session is gone, and its own message is what a window shows for one.
    const cwd = await node.pty.cwd(sessionId);
    const session = (await node.pty.list()).find((item) => item.id === sessionId);
    if (!session) throw new Error('这个终端已经找不到了');
    return ref(machine, node, session, cwd);
  }));
  handlers.push(context.ui.handle('address', (sessionId: string) => {
    const node = connections.get(key(machineOf(sessionId)));
    if (!node) throw new Error('Machine is not connected');
    return `ws://localhost:${node.port}`;
  }));
  handlers.push(context.ui.handle('close', async (sessionId: string) => {
    const machine = machineOf(sessionId);
    delete sessions.value[sessionId];
    sessions.save();
    try { await (await connection(machine)).pty.close(sessionId); } catch { /* the session is gone either way */ }
  }));

  return () => {
    for (const remove of handlers) remove();
    for (const node of connections.values()) node.disconnect();
  };
}
