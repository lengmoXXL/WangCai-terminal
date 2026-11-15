import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import type { WorkspaceActive } from '@lengmoxxl/sdk';
import type { TabRecord, UiContext } from '@lengmoxxl/sdk/channel';
import { bindKeys, pressIn } from '@lengmoxxl/sdk/keys';
import type { Settings, TerminalView } from './shared';
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

function TerminalPane({ context, workspaceId, sessionId, active }: { context: UiContext; workspaceId: string; sessionId: string; active: boolean }) {
  const element = useRef<HTMLDivElement>(null);
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
      if (!alive) { chunks = []; return; }
      const joined = chunks.length === 1 ? chunks[0] : concat(chunks);
      chunks = [];
      term.write(joined);
    };
    // One write a frame, as the terminal VS Code draws: the agent hands over more frames than the screen needs.
    const feed = (data: Uint8Array) => {
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
      try { url = await context.ui.request<string>('address', workspaceId); }
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
    // A shell the bar does not have in front keeps its session attached and its buffer fed, so coming back only fits the grid again: no re-attach, no replay, no reset.
    const shownObserver = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting === shown) return;
      shown = entry.isIntersecting;
    });
    shownObserver.observe(element.current!);
    return () => {
      alive = false;
      clearTimeout(retry);
      cancelAnimationFrame(frame);
      input.dispose(); resize.dispose(); observer.disconnect(); shownObserver.disconnect();
      socket?.close(); term.dispose();
    };
  }, [context, workspaceId, sessionId]);

  return <div className="terminal-pane" hidden={!active}>
    <div className="terminal-surface" ref={element} />
    {error && <div className="terminal-message error" role="alert">{error}</div>}
  </div>;
}

// The shell a workspace's tab last had in front, so a tab drawn again comes back to the same one.
const fronts = new Map<string, string>();

function TerminalSessions({ context, view }: { context: UiContext; view: TerminalView }) {
  const [sessions, setSessions] = useState(view.sessions);
  const [front, setFront] = useState(() => (sessions.find((item) => item.sessionId === fronts.get(view.workspaceId)) ?? sessions[0]).sessionId);
  const [error, setError] = useState('');
  // The shell whose name is being typed, and what the field holds while it is.
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const element = useRef<HTMLDivElement>(null);

  const pick = (sessionId: string) => { fronts.set(view.workspaceId, sessionId); setFront(sessionId); };
  const step = (direction: number) => {
    const at = sessions.findIndex((item) => item.sessionId === front);
    pick(sessions[(at + direction + sessions.length) % sessions.length].sessionId);
  };
  const create = async () => {
    if (!activeTerminal) { setError(noTerminal); return; }
    try {
      const next = await context.ui.request<TerminalView>('create', activeTerminal);
      setSessions(next.sessions);
      pick(next.sessions.at(-1)!.sessionId);
    } catch (failure) { setError((failure as Error).message); }
  };
  const kill = async (sessionId: string) => {
    try { await context.ui.request('kill', { workspaceId: view.workspaceId, sessionId }); }
    catch (failure) { setError((failure as Error).message); return; }
    const at = sessions.findIndex((item) => item.sessionId === sessionId);
    const rest = sessions.filter((item) => item.sessionId !== sessionId);
    // The last shell is the tab itself, which the window closes; closing it is what takes the tab's own entry away.
    if (!rest.length) { void context.global.publish('core:close-tab', null); return; }
    // The pane going away takes the focus with it, so the page holds the keys until the shell beside it takes them.
    if (front === sessionId) {
      element.current?.closest<HTMLElement>('[data-plugin]')?.focus();
      pick(rest[Math.max(at - 1, 0)].sessionId);
    }
    setSessions(rest);
  };

  // What the page draws is a terminal, and the keys of the page belong to the shell the bar has in front.
  const focusFront = () => element.current?.querySelector<HTMLElement>('.terminal-pane:not([hidden]) .xterm-helper-textarea')?.focus();
  const stopRename = () => { setRenaming(null); focusFront(); };
  const rename = async (sessionId: string, title: string) => {
    stopRename();
    const name = title.trim();
    if (!name || name === sessions.find((item) => item.sessionId === sessionId)?.title) return;
    try {
      await context.ui.request('rename', { workspaceId: view.workspaceId, sessionId, title: name });
      setSessions(sessions.map((item) => item.sessionId === sessionId ? { ...item, title: name } : item));
    } catch (failure) { setError((failure as Error).message); }
  };

  // A key that shows this view leaves the keys on the page, so the shell in front takes them; Ctrl+Shift+Q leaves them
  // on the page instead, where the bar's own keys still answer.
  useEffect(() => {
    const page = element.current?.closest<HTMLElement>('[data-plugin]');
    if (!page) return;
    page.addEventListener('wangcai:shown', focusFront);
    // A page a key opened is focused before the terminal in it exists, so the keys are taken here as well.
    if (page.contains(document.activeElement)) focusFront();
    return () => page.removeEventListener('wangcai:shown', focusFront);
  }, [front]);

  // Ctrl+Shift+H and L walk the bar, N opens a shell, W closes the one in front and R names it. They are bound over the
  // whole page, the terminal's own field included, and are taken before the terminal reads them; the name field keeps
  // the keys of its own while it is open.
  useEffect(() => {
    const page = element.current?.closest<HTMLElement>('[data-plugin]');
    if (!page) return;
    return bindKeys(page, [
      { keys: '<C-S-h>', run: () => step(-1) },
      { keys: '<C-S-l>', run: () => step(1) },
      { keys: '<C-S-n>', run: () => void create() },
      { keys: '<C-S-w>', run: () => void kill(front) },
      { keys: '<C-S-r>', run: () => { setDraft(sessions.find((item) => item.sessionId === front)?.title ?? ''); setRenaming(front); } },
    ], { fields: 'all', ignore: (event) => pressIn(event, '.terminal-rename') });
  }, [sessions, front]);

  return <div className="terminal-view" ref={element}>
    <div className="terminal-bar" role="tablist" aria-label="终端会话">
      {sessions.map((item) => <div className="terminal-session" key={item.sessionId}>
        {/* Enter takes the name; leaving the field any other way leaves the name as it was. */}
        {renaming === item.sessionId
          ? <input className="terminal-rename" autoFocus value={draft} aria-label={`重命名 ${item.title}`}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => setRenaming(null)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void rename(item.sessionId, draft);
              else if (event.key === 'Escape') stopRename();
            }} />
          : <button role="tab" aria-selected={item.sessionId === front} title={`${view.machine.name}: ${item.location}`}
            onClick={() => pick(item.sessionId)}>{item.title}</button>}
        <button className="terminal-session-close" aria-label={`关闭 ${item.title}`} onClick={() => void kill(item.sessionId)}>×</button>
      </div>)}
      <button className="terminal-new" aria-label="新建终端" onClick={() => void create()}>+</button>
    </div>
    {error && <div className="terminal-message error" role="alert">{error}</div>}
    {sessions.map((item) => <TerminalPane key={item.sessionId} context={context} workspaceId={view.workspaceId}
      sessionId={item.sessionId} active={item.sessionId === front} />)}
  </div>;
}

function openView(context: UiContext, view: TerminalView) {
  context.host.tabs({
    id: 'terminal', title, tooltip: view.machine.name, workspaceId: view.workspaceId,
    onClose: () => { void context.ui.request('close', view.workspaceId).catch(() => {}); },
    mount(container: HTMLElement) {
      container.classList.add('wangcai-terminal');
      container.style.fontFamily = profile.font.family;
      const root = createRoot(container);
      return {
        // A tab redrawn because the app's list changed is not a selection, so this only redraws and leaves the focus alone.
        onSelect: () => { root.render(<TerminalSessions context={context} view={view} />); },
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
    else void context.ui.request<TerminalView>('describe', record.workspaceId)
      .then((view) => openView(context, view))
      .catch((error: Error) => showMessage(context, record.id, error.message, record.workspaceId));
    return;
  }
  const terminal = activeTerminal;
  if (!terminal) {
    showMessage(context, 'message', noTerminal);
    return;
  }
  void context.ui.request<TerminalView>('open', terminal)
    .then((view) => openView(context, view))
    .catch((error: Error) => showMessage(context, 'message', error.message, terminal.workspaceId));
}

export function mount(_container: HTMLElement, context: UiContext) {
  profile = context.host.config;
  const off = context.global.subscribe<WorkspaceActive | null>('workspace:active', (value) => { activeTerminal = value; });
  void context.global.publish('workspace:query', null);
  return off;
}
