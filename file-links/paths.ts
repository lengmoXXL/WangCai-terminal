import { posix } from 'node:path';
import type { FileClick, Machine, MachineConnection } from '@wangcai/sdk';
import type { MainContext } from '@wangcai/sdk/channel';

/** How long a path stays answered. */
const resolvedTtl = 10_000;

/** The machine a session runs on, and the live connection to it. */
interface Host {
  machine: Machine;
  node: MachineConnection;
}

/** A request names its session, which the plugin's main realm turns into the machine behind it. */
export function registerFilePaths(context: MainContext, hostOf: (sessionId: string) => Host | undefined) {
  const resolved = new Map<string, string | undefined>();
  let resolvedUntil = 0;
  return [
    context.ui.handle('resolve', async ({ sessionId, paths }: { sessionId: string; paths: string[] }) => {
      const host = hostOf(sessionId);
      if (!host) return {};
      if (Date.now() > resolvedUntil) {
        resolved.clear();
        resolvedUntil = Date.now() + resolvedTtl;
      }
      const cwd = await host.node.pty.cwd(sessionId);
      const wanted = paths.map((text) => ({
        text,
        key: `${host.machine.id}\0${cwd}\0${text}`,
        path: posix.isAbsolute(text) ? posix.resolve(text) : posix.resolve(cwd, text),
      }));
      // One look per path, all of them at once: a remote machine answers a batch in one round trip
      // rather than one per path.
      await Promise.all(wanted.map(async (item) => {
        if (resolved.has(item.key)) return;
        resolved.set(item.key, (await host.node.fs.stat(item.path)) ? item.path : undefined);
      }));
      const found: Record<string, string> = {};
      for (const item of wanted) {
        const path = resolved.get(item.key);
        if (path) found[item.text] = path;
      }
      return found;
    }),
    context.ui.handle('click', async ({ sessionId, location }: { sessionId: string; location: Pick<FileClick, 'path' | 'line' | 'column'> }) => {
      const host = hostOf(sessionId);
      if (!host) throw new Error('Machine is not connected');
      const path = posix.isAbsolute(location.path) ? posix.resolve(location.path) : posix.resolve(await host.node.pty.cwd(sessionId), location.path);
      const stat = await host.node.fs.stat(path);
      if (!stat) return;
      await context.global.publish('onclick', { type: stat.isDirectory ? 'directory' : 'file', machine: host.machine, ...location, path });
    }),
  ];
}
