import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { FitAddon } from '@xterm/addon-fit';
import type { WorkspaceActive } from '@lengmoxxl/sdk';
import type { TabRecord, UiContext } from '@lengmoxxl/sdk/channel';
import { registerFileLinks } from './file-links/links';
import type { Settings, TerminalRef } from './shared';
import '@xterm/xterm/css/xterm.css';
import './style.css';

export const title = '终端';

let profile: Settings;
let activeTerminal: WorkspaceActive | null = null;

function TerminalPane({ context, sessionId, activation }: { context: UiContext; sessionId: string; activation: number }) {
  const element = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const term = new Terminal({
      fontSize: profile.font.size, lineHeight: profile.font.lineHeight,
      fontFamily: profile.font.family,
      // xterm takes its scrollbar width from the overview ruler, which also paints the ruler outline.
      overviewRuler: { width: 10 },
      scrollback: 10_000,
      theme: { ...profile.theme, overviewRulerBorder: profile.theme.background, selectionBackground: profile.theme.selection },
    });
    const addon = new FitAddon();
    term.loadAddon(addon);
    // What a program in the terminal copies goes to the system clipboard: OSC 52.
    term.loadAddon(new ClipboardAddon());
    // What the terminal prints as a web address is a link the app opens in a browser.
    term.loadAddon(new WebLinksAddon((_event, uri) => { void context.host.open(uri).catch((error: Error) => setError(error.message)); }));
    term.open(element.current!);
    const links = registerFileLinks(term, {
      resolve: (paths) => context.ui.request('resolve', { sessionId, paths }),
      activate: (path, line, column) => { void context.ui.request('click', { sessionId, location: { path, line, column } }).catch((error: Error) => setError(error.message)); },
    });
    terminal.current = term;
    let alive = true;
    let replaying = false;
    let ready = false;
    let socket: WebSocket | undefined;
    const send = (op: string, params: Record<string, unknown> = {}) => {
      socket!.send(JSON.stringify({ op, session_id: sessionId, ...params }));
    };
    const sendSize = () => {
      if (!ready || replaying) return;
      send('resize', { rows: term.rows, cols: term.cols });
    };
    void context.ui.request<string>('address', sessionId).then((url) => {
      if (!alive) return;
      socket = new WebSocket(url);
      // Chromium hands binary frames over as blobs unless it is told otherwise.
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => send('attach');
      const decoder = new TextDecoder();
      socket.onmessage = ({ data }) => {
        if (!alive) return;
        if (typeof data === 'string') {
          const reply = JSON.parse(data);
          if (reply.error) setError(reply.error);
          return;
        }
        const bytes = new Uint8Array(data);
        const length = new DataView(data).getUint32(0);
        const event = JSON.parse(decoder.decode(bytes.subarray(4, 4 + length))) as { event: string; rows: number; cols: number };
        const payload = bytes.subarray(4 + length);
        if (event.event === 'snapshot') {
          replaying = true;
          ready = true;
          term.reset();
          term.resize(event.cols, event.rows);
          term.write(payload, () => {
            if (!alive) return;
            replaying = false;
            if (!element.current?.offsetWidth) return;
            addon.fit();
            sendSize();
          });
          return;
        }
        term.write(payload);
      };
      socket.onclose = () => { if (alive) setError('终端连接已断开'); };
    }).catch((error: Error) => { if (alive) setError(error.message); });
    const input = term.onData((data) => {
      if (!ready || replaying) return;
      send('input', { data });
    });
    const resize = term.onResize(sendSize);
    const observer = new ResizeObserver(() => {
      if (!replaying && element.current?.offsetWidth && element.current?.offsetHeight) addon.fit();
    });
    observer.observe(element.current!);
    return () => {
      alive = false;
      input.dispose(); resize.dispose(); observer.disconnect();
      links.dispose(); socket?.close(); term.dispose();
      terminal.current = null;
    };
  }, [context, sessionId]);

  useEffect(() => {
    requestAnimationFrame(() => terminal.current?.focus());
  }, [activation]);

  return <div className="terminal-pane">
    <div className="terminal-surface" ref={element} />
    {error && <div className="terminal-message error" role="alert">{error}</div>}
  </div>;
}

function openTab(context: UiContext, tab: TerminalRef & { workspaceId?: string }) {
  context.host.tabs({
    id: tab.sessionId, title: tab.label, tooltip: `${tab.machine.name}: ${tab.label}`, workspaceId: tab.workspaceId,
    onClose: () => { void context.ui.request('close', tab.sessionId).catch(() => {}); },
    mount(container: HTMLElement) {
      container.classList.add('wangcai-terminal');
      container.style.fontFamily = profile.font.family;
      const root = createRoot(container);
      let activation = 0;
      return {
        onSelect: () => { root.render(<TerminalPane context={context} sessionId={tab.sessionId} activation={++activation} />); },
        dispose: () => root.unmount(),
      };
    },
  });
}

function showMessage(context: UiContext, id: string, message: string, workspaceId?: string) {
  context.host.tabs({
    id, title: '终端', tooltip: message, workspaceId,
    mount(container: HTMLElement) {
      container.classList.add('wangcai-terminal');
      container.style.fontFamily = profile.font.family;
      const text = document.createElement('div');
      text.className = 'terminal-message';
      text.textContent = message;
      container.append(text);
      return { dispose: () => text.remove() };
    },
  });
}

const noTerminal = '请先打开一个工作区终端';

export function open(context: UiContext, record?: TabRecord) {
  if (record) {
    // A remembered tab: the message one has no session left to describe.
    if (record.id === 'message') showMessage(context, 'message', noTerminal, record.workspaceId);
    else void context.ui.request<TerminalRef>('describe', record.id)
      .then((tab) => openTab(context, { ...tab, workspaceId: record.workspaceId }))
      .catch((error: Error) => showMessage(context, record.id, error.message, record.workspaceId));
    return;
  }
  const terminal = activeTerminal;
  if (!terminal) {
    showMessage(context, 'message', noTerminal);
    return;
  }
  void context.ui.request<TerminalRef>('open', terminal)
    .then((tab) => openTab(context, { ...tab, workspaceId: terminal.workspaceId }))
    .catch((error: Error) => showMessage(context, 'message', error.message, terminal.workspaceId));
}

export function mount(_container: HTMLElement, context: UiContext) {
  profile = context.host.config;
  const off = context.global.subscribe<WorkspaceActive | null>('workspace:active', (value) => { activeTerminal = value; });
  void context.global.publish('workspace:query', null);
  return off;
}
