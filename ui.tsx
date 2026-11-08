import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import type { WorkspaceActive } from '@lengmoxxl/sdk';
import type { TabRecord, UiContext } from '@lengmoxxl/sdk/channel';
import type { Settings, TerminalRef } from './shared';
import '@xterm/xterm/css/xterm.css';
import './style.css';

export const title = '终端';

const concat = (chunks: Uint8Array[]) => {
  const joined = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) { joined.set(chunk, at); at += chunk.length; }
  return joined;
};

let profile: Settings;
let activeTerminal: WorkspaceActive | null = null;

function TerminalPane({ context, tabId, sessionId }: { context: UiContext; tabId: string; sessionId: string }) {
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
    // What a program in the terminal copies goes to the system clipboard: OSC 52.
    term.loadAddon(new ClipboardAddon());
    // A program asks for its cursor with DECSCUSR, and its reset, `CSI 0 SP q`, means the terminal's own default, which
    // xterm 5.5 reads as a blinking block instead. Every other parameter already matches, so only the reset is answered.
    term.parser.registerCsiHandler({ intermediates: ' ', final: 'q' }, (params) => {
      if (Number(params[0]) !== 0) return false;
      term.options.cursorStyle = 'block';
      term.options.cursorBlink = false;
      return true;
    });
    // A program can mark text as a link (OSC 8). This terminal shows none, so the sequence is taken and dropped, which
    // keeps xterm from drawing a link of its own over the text.
    term.parser.registerOscHandler(8, () => true);
    term.open(element.current!);
    // The rows are drawn on a canvas: the DOM renderer rebuilds the elements of every row a frame changes.
    try {
      const webglAddon = new WebglAddon();
      // A GPU that takes its context away hands the rows back to the DOM renderer.
      webglAddon.onContextLoss(() => webglAddon.dispose());
      term.loadAddon(webglAddon);
    } catch { /* a GPU that cannot draw here leaves the rows as elements */ }
    terminal.current = term;
    let alive = true;
    let replaying = false;
    let ready = false;
    let socket: WebSocket | undefined;
    let attempt = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let shown = element.current!.offsetWidth > 0;
    let frame = 0;
    let chunks: Uint8Array[] = [];
    const flush = () => {
      frame = 0;
      if (!alive || !shown) { chunks = []; return; }
      const joined = chunks.length === 1 ? chunks[0] : concat(chunks);
      chunks = [];
      term.write(joined);
    };
    // One write a frame, as the terminal VS Code draws: the agent hands over more frames than the screen needs.
    const feed = (data: Uint8Array) => {
      if (!shown) return;
      chunks.push(data);
      if (!frame) frame = requestAnimationFrame(flush);
    };
    const send = (op: string, params: Record<string, unknown> = {}) => {
      socket!.send(JSON.stringify({ op, session_id: sessionId, ...params }));
    };
    const sendSize = () => {
      if (!ready || replaying) return;
      send('resize', { rows: term.rows, cols: term.cols });
    };
    const close = () => {
      ready = false;
      replaying = false;
      chunks = [];
      cancelAnimationFrame(frame);
      frame = 0;
      if (socket?.readyState === WebSocket.OPEN) send('detach');
      socket?.close();
      socket = undefined;
    };
    const reconnect = (error: Error) => {
      if (!alive || !shown || retry !== undefined) return;
      ready = false;
      setError(`${error.message}，正在重连…`);
      retry = setTimeout(() => void connect(), Math.min(1000 * 2 ** attempt++, 5000));
    };
    // The app hands out another port when it reconnects, so every attempt asks for the address again.
    const connect = async () => {
      retry = undefined;
      if (!alive || !shown) return;
      let url: string;
      try { url = await context.ui.request<string>('address', tabId); }
      catch (error) { reconnect(error as Error); return; }
      if (!alive || !shown) return;
      socket = new WebSocket(url);
      // Chromium hands binary frames over as blobs unless it is told otherwise.
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => { attempt = 0; if (shown) send('attach'); else close(); };
      const decoder = new TextDecoder();
      socket.onmessage = ({ data }) => {
        if (!alive) return;
        if (typeof data === 'string') {
          const reply = JSON.parse(data);
          if (reply.error) setError(reply.error);
          return;
        }
        if (!shown) return;
        const bytes = new Uint8Array(data);
        const length = new DataView(data).getUint32(0);
        const event = JSON.parse(decoder.decode(bytes.subarray(4, 4 + length))) as { event: string; rows: number; cols: number };
        const payload = bytes.subarray(4 + length);
        if (event.event === 'snapshot') {
          setError('');
          replaying = true;
          ready = true;
          chunks = [];
          term.reset();
          term.resize(event.cols, event.rows);
          term.write(payload, () => {
            if (!alive) return;
            replaying = false;
            if (!shown) return;
            fit();
            sendSize();
          });
          return;
        }
        feed(payload);
      };
      socket.onclose = () => { if (alive && shown) reconnect(new Error('终端连接已断开')); };
    };
    if (shown) void connect();
    const input = term.onData((data) => {
      if (!ready || replaying) return;
      send('input', { data });
    });
    const resize = term.onResize(sendSize);
    const observer = new ResizeObserver(() => { if (!replaying) fit(); });
    observer.observe(element.current!);
    // The tab in front is the only one drawn: a hidden tab lets its session go, and takes it back when it comes in front.
    const shownObserver = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting === shown) return;
      shown = entry.isIntersecting;
      if (shown) void connect(); else close();
    });
    shownObserver.observe(element.current!);
    return () => {
      alive = false;
      clearTimeout(retry);
      cancelAnimationFrame(frame);
      input.dispose(); resize.dispose(); observer.disconnect(); shownObserver.disconnect();
      socket?.close(); term.dispose();
      terminal.current = null;
    };
  }, [context, tabId, sessionId]);

  // A key that shows this view leaves the keys on the page, and what the page draws is a terminal. Two Escapes leave a
  // field the same way, and there the focus stays where they put it.
  useEffect(() => {
    const page = element.current?.closest<HTMLElement>('[data-plugin]');
    if (!page) return;
    const focus = () => terminal.current?.focus();
    page.addEventListener('wangcai:shown', focus);
    // A page a key opened is focused before the terminal in it exists, so it is taken here as well.
    if (page === document.activeElement) focus();
    return () => page.removeEventListener('wangcai:shown', focus);
  }, []);

  return <div className="terminal-pane">
    <div className="terminal-surface" ref={element} />
    {error && <div className="terminal-message error" role="alert">{error}</div>}
  </div>;
}

function openTab(context: UiContext, tab: TerminalRef & { workspaceId?: string }) {
  context.host.tabs({
    id: tab.tabId, title: tab.title, tooltip: `${tab.machine.name}: ${tab.location}`, workspaceId: tab.workspaceId,
    onClose: () => { void context.ui.request('close', tab.tabId).catch(() => {}); },
    mount(container: HTMLElement) {
      container.classList.add('wangcai-terminal');
      container.style.fontFamily = profile.font.family;
      const root = createRoot(container);
      return {
        // A tab redrawn because the app's list changed is not a selection, so this only redraws and leaves the focus alone.
        onSelect: () => { root.render(<TerminalPane context={context} tabId={tab.tabId} sessionId={tab.sessionId} />); },
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
