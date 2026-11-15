import type { Machine, Profile } from '@lengmoxxl/sdk';
export type { Machine };

// The config this plugin accepts: main.ts declares a schema for the same fields.
export type Font = { family: string; size: number; lineHeight: number };
export type Settings = Profile & { font: Font };

// One shell of the tab: `sessionId` names the shell it reads now, `title` what the bar calls it, and `location` where
// that shell sits.
export interface TerminalSession { sessionId: string; title: string; location: string }
// The one tab a workspace's terminals share, and every shell it holds, in the order the bar draws them.
export interface TerminalView { machine: Machine; workspaceId: string; sessions: TerminalSession[] }
