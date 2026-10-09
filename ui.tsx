import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { FitAddon } from '@xterm/addon-fit';
import type { TerminalEvent, WorkspaceActive } from '@lengmoxxl/sdk';
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
      cursorBlink: true, fontSize: profile.font.size, lineHeight: profile.font.lineHeight,
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
    const sendSize = () => {
      if (!alive || !ready || replaying) return;
      void context.ui.request('pty', { op: 'resize', sessionId, params: { rows: term.rows, cols: term.cols } }).catch((error: Error) => { if (alive) setError(error.message); });
    };
    const unsubscribe = context.ui.subscribe<TerminalEvent>('terminal', (event) => {
      if (!alive || event.session_id !== sessionId) return;
      if (event.event === 'snapshot') {
        replaying = true;
        term.reset();
        term.resize(event.cols, event.rows);
        term.write(event.data, () => {
          if (!alive) return;
          replaying = false;
          if (!element.current?.offsetWidth) return;
          addon.fit();
          sendSize();
        });
      } else {
        term.write(event.data);
      }
    });
    const input = term.onData((data) => {
      if (!ready || replaying) return;
      void context.ui.request('pty', { op: 'input', sessionId, params: { data } }).catch((error: Error) => { if (alive) setError(error.message); });
    });
    const resize = term.onResize(sendSize);
    const observer = new ResizeObserver(() => {
      if (!replaying && element.current?.offsetWidth && element.current?.offsetHeight) addon.fit();
    });
    observer.observe(element.current!);
    void context.ui.request('attach', sessionId).then(() => {
      if (!alive) return;
      ready = true;
      sendSize();
    }).catch((error: Error) => { if (alive) setError(error.message); });
    return () => {
      alive = false;
      unsubscribe(); input.dispose(); resize.dispose(); observer.disconnect();
      links.dispose(); term.dispose();
      terminal.current = null;
      void context.ui.request('pty', { op: 'detach', sessionId }).catch(() => {});
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
