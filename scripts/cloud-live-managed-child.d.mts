import type { ChildProcess } from 'node:child_process';
export function runManagedChild(options: {
  spawnChild: () => ChildProcess;
  hardMs?: number;
  workMs?: number;
  grant?: { id: string; scenario: string; parentPid: number; nonce: string };
}): Promise<{ cleanClose: boolean; outcome: string; wallMs: number }>;
