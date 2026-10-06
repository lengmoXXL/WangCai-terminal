import type { Machine, Profile } from '@wangcai/sdk';
export type { Machine };

// The config this plugin accepts: main.ts declares a schema for the same fields.
export type Font = { family: string; size: number; lineHeight: number };
export type Settings = Profile & { font: Font };

export interface TerminalRef { machine: Machine; sessionId: string; label: string }
