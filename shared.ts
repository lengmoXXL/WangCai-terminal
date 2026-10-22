import type { Machine, Profile } from '@lengmoxxl/sdk';
export type { Machine };

// The config this plugin accepts: main.ts declares a schema for the same fields.
export type Font = { family: string; size: number; lineHeight: number };
export type Settings = Profile & { font: Font };

// `title` is what the session is shown under, `location` where its shell sits.
export interface TerminalRef { machine: Machine; sessionId: string; title: string; location: string }
