import type { Machine, Profile } from '@lengmoxxl/sdk';
export type { Machine };

// The config this plugin accepts: main.ts declares a schema for the same fields.
export type Font = { family: string; size: number; lineHeight: number };
export type Settings = Profile & { font: Font };

// `tabId` names the tab for as long as it is open, `sessionId` the shell it reads now, `title` what it is shown under
// and `location` where its shell sits.
export interface TerminalRef { machine: Machine; tabId: string; sessionId: string; title: string; location: string }
