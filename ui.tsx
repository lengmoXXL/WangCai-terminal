import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import type { WorkspaceActive } from '@lengmoxxl/sdk';
import type { TabRecord, UiContext } from '@lengmoxxl/sdk/channel';
import { trackCommand } from './command';
import { registerFileLinks } from './file-links/links';
import type { Settings, TerminalRef } from './shared';
import '@xterm/xterm/css/xterm.css';
import './style.css';

export const title = '终端';

let profile: Settings;
let activeTerminal: WorkspaceActive | null = null;

function TerminalPane({ context, sessionId }: { context: UiContext; sessionId: string }) {
  const element = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const term = new Terminal({
      fontSize: profile.font.size, lineHeight: profile.font.lineHeight,
      fontFamily: profile.font.family,
      scrollback: 10_000,
      theme: { ...profile.theme, selectionBackground: profile.theme.selection },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    // The addon keeps back the column a scrollbar would take, which leaves the grid a column short of the pane: the
    // columns are counted from the pane's width instead.
    const fit = () => {
      const pane = element.current;
      const proposed = fitAddon.proposeDimensions();
      if (!pane?.offsetWidth || !pane.offsetHeight || !proposed) return;
      const screen = term.element?.querySelector('.xterm-screen');
      const cell = screen && term.cols ? screen.getBoundingClientRect().width / term.cols : 0;
      const cols = cell ? Math.floor(pane.clientWidth / cell) : proposed.cols;
      if (cols !== term.cols || proposed.rows !== term.rows) term.resize(cols, proposed.rows);
    };
    // A program asks for its cursor with DECSCUSR, and its reset, `CSI 0 SP q`, means the terminal's own default, which
    // xterm 5.5 reads as a blinking block instead. Every other parameter already matches, so only the reset is answered.
    term.parser.registerCsiHandler({ intermediates: ' ', final: 'q' }, (params) => {
      if (Number(params[0]) !== 0) return false;
      term.options.cursorStyle = 'block';
      term.options.cursorBlink = false;
      return true;
    });
    // What a program in the terminal copies goes to the system clipboard: OSC 52.
    term.loadAddon(new ClipboardAddon());
    const openAddress = (uri: string) => { void context.host.open(uri).catch((error: Error) => setError(error.message)); };
    // What the terminal prints as a web address is a link the app opens in a browser, on the click that holds
    // Command: on its own the click stays a click in the terminal.
    term.loadAddon(new WebLinksAddon((event, uri) => { if (event.metaKey) openAddress(uri); }));
    term.open(element.current!);
    // The rows are drawn on a canvas: the DOM renderer rebuilds the elements of every row a frame changes.
    try {
      const webglAddon = new WebglAddon();
      // A GPU that takes its context away hands the rows back to the DOM renderer.
      webglAddon.onContextLoss(() => webglAddon.dispose());
      term.loadAddon(webglAddon);
    } catch { /* a GPU that cannot draw here leaves the rows as elements */ }
    const links = registerFileLinks(term, {
      resolve: (paths) => context.ui.request('resolve', { sessionId, paths }),
      activate: (path, line, column) => { void context.ui.request('click', { sessionId, location: { path, line, column } }).catch((error: Error) => setError(error.message)); },
      openAddress,
    });
    // Command is what shows a link, and what the click on it opens with.
    const command = trackCommand(term.element!, links.setCommand);
    terminal.current = term;
    let alive = true;
    let replaying = false;
    let ready = false;
    let socket: WebSocket | undefined;
    let attempt = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const send = (op: string, params: Record<string, unknown> = {}) => {
      socket!.send(JSON.stringify({ op, session_id: sessionId, ...params }));
    };
    const sendSize = () => {
      if (!ready || replaying) return;
      send('resize', { rows: term.rows, cols: term.cols });
    };
    const reconnect = (error: Error) => {
      if (!alive || retry !== undefined) return;
      ready = false;
      setError(`${error.message}，正在重连…`);
      retry = setTimeout(() => void connect(), Math.min(1000 * 2 ** attempt++, 5000));
    };
    // The app hands out another port when it reconnects, so every attempt asks for the address again.
    const connect = async () => {
      retry = undefined;
      if (!alive) return;
      let url: string;
      try { url = await context.ui.request<string>('address', sessionId); }
      catch (error) { reconnect(error as Error); return; }
      if (!alive) return;
      socket = new WebSocket(url);
      // Chromium hands binary frames over as blobs unless it is told otherwise.
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => { attempt = 0; send('attach'); };
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
          setError('');
          replaying = true;
          ready = true;
          term.reset();
          term.resize(event.cols, event.rows);
          term.write(payload, () => {
            if (!alive) return;
            replaying = false;
            if (!element.current?.offsetWidth) return;
            fit();
            sendSize();
          });
          return;
        }
        term.write(payload);
      };
      socket.onclose = () => { if (alive) reconnect(new Error('终端连接已断开')); };
    };
    void connect();
    const input = term.onData((data) => {
      if (!ready || replaying) return;
      send('input', { data });
    });
    const resize = term.onResize(sendSize);
    const observer = new ResizeObserver(() => { if (!replaying) fit(); });
    observer.observe(element.current!);
    return () => {
      alive = false;
      clearTimeout(retry);
      input.dispose(); resize.dispose(); observer.disconnect();
      command.dispose(); links.dispose(); socket?.close(); term.dispose();
      terminal.current = null;
    };
  }, [context, sessionId]);

  // A key that shows this view leaves the keys on the panel, and what the panel draws is a terminal. Two Escapes leave a
  // field the same way, and there the focus stays where they put it.
  useEffect(() => {
    const panel = element.current?.closest<HTMLElement>('[data-plugin]');
    if (!panel) return;
    const focus = () => { if (element.current?.offsetWidth) terminal.current?.focus(); };
    panel.addEventListener('wangcai:shown', focus);
    // A panel a key opened is focused before the pane in it exists, so it is taken here as well.
    if (panel === document.activeElement) focus();
    return () => panel.removeEventListener('wangcai:shown', focus);
  }, []);

  return <div className="terminal-pane">
    <div className="terminal-surface" ref={element} />
    {error && <div className="terminal-message error" role="alert">{error}</div>}
  </div>;
}

function openTab(context: UiContext, tab: TerminalRef & { workspaceId?: string }) {
  context.host.tabs({
    id: tab.sessionId, title: tab.title, tooltip: `${tab.machine.name}: ${tab.location}`, workspaceId: tab.workspaceId,
    onClose: () => { void context.ui.request('close', tab.sessionId).catch(() => {}); },
    mount(container: HTMLElement) {
      container.classList.add('wangcai-terminal');
      container.style.fontFamily = profile.font.family;
      const root = createRoot(container);
      return {
        // A tab redrawn because the app's list changed is not a selection, so only a click on the pane takes the focus.
        onSelect: () => { root.render(<TerminalPane context={context} sessionId={tab.sessionId} />); },
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
