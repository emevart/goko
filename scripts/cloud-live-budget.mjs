import { openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync, fsyncSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CloudProbeError } from './cloud-live-transport.mjs';

const fail = code => { throw new CloudProbeError(code); };
export const BUDGET_LIMITS = Object.freeze({ providerSessions: 2, wallMs: 180_000 });
export const ATTEMPT_RESERVE_MS = 90_000;
const scenarios = new Set(['first', 'ambiguity', 'facts', 'repair']);
function lock(path) {
  let fd;
  try { fd = openSync(`${path}.lock`, 'wx', 0o600); }
  catch (error) { fail(error.code === 'EEXIST' ? 'CLOUD_BUDGET_LOCKED' : 'CLOUD_LEDGER_MISSING'); }
  const identity = { ownerPid: process.pid, nonce: randomUUID() };
  writeFileSync(fd, JSON.stringify(identity)); fsyncSync(fd);
  return { identity, release: () => { closeSync(fd); unlinkSync(`${path}.lock`); } };
}
function read(path) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch (error) { fail(error.code === 'ENOENT' ? 'CLOUD_LEDGER_MISSING' : 'CLOUD_LEDGER_CORRUPT'); }
  try { return JSON.parse(raw); } catch { fail('CLOUD_LEDGER_CORRUPT'); }
}
function atomicWrite(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(temp, 'wx', 0o600); writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temp, path);
    const dir = openSync(dirname(path), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
  } finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temp); } catch {} }
}
export function initializeBudget(path) {
  const { release } = lock(path);
  try {
    const old = read(path);
    if (old?.schema !== 'cloud-product-audit-v1' || old.limits?.providerSessions !== 2 || old.limits?.connectionSeconds !== 180 || old.used?.providerSessions !== 0 || old.used?.connectionSeconds !== 0 || !Array.isArray(old.attempts) || old.attempts.length || old.paidRunEnabled !== false || old.status !== 'blocked_before_connection') fail('CLOUD_AUDIT_NOT_ZERO');
    atomicWrite(path, { schema: 'cloud-live-budget-v2', limits: BUDGET_LIMITS, used: { providerSessions: 0, wallMs: 0 }, attempts: [], migratedFrom: old });
  } finally { release(); }
}
function validate(ledger) {
  if (ledger?.schema !== 'cloud-live-budget-v2' || ledger.limits?.providerSessions !== 2 || ledger.limits?.wallMs !== 180000 || !Array.isArray(ledger.attempts) || ledger.attempts.length > 2 || !Number.isInteger(ledger.used?.wallMs) || ledger.used.wallMs < 0 || ledger.used.wallMs > 180000 || ledger.used.providerSessions !== ledger.attempts.length) fail('CLOUD_LEDGER_CORRUPT');
  let total = 0; const ids = new Set();
  for (const a of ledger.attempts) {
    if (!a || typeof a.id !== 'string' || ids.has(a.id) || !scenarios.has(a.scenario) || !['reserved', 'closed'].includes(a.state) || !Number.isInteger(a.wallMs) || a.wallMs < 1 || a.wallMs > ATTEMPT_RESERVE_MS || (a.state === 'reserved' && a.wallMs !== ATTEMPT_RESERVE_MS)) fail('CLOUD_LEDGER_CORRUPT');
    ids.add(a.id); total += a.wallMs;
  }
  if (total !== ledger.used.wallMs) fail('CLOUD_LEDGER_CORRUPT');
  return ledger;
}
export function inspectBudget(path) { return validate(read(path)); }
export function reserveBudget(path, scenario) {
  if (!scenarios.has(scenario)) fail('CLOUD_SCENARIO_INVALID');
  const { release, identity } = lock(path);
  let held = true;
  try {
    const ledger = validate(read(path));
    if (ledger.attempts.some(a => a.state === 'reserved')) fail('CLOUD_ATTEMPT_IN_PROGRESS');
    if (ledger.used.providerSessions >= 2 || ledger.used.wallMs + ATTEMPT_RESERVE_MS > 180000) fail('CLOUD_BUDGET_EXHAUSTED');
    const attempt = { id: randomUUID(), scenario, state: 'reserved', wallMs: ATTEMPT_RESERVE_MS, startedAt: new Date().toISOString() };
    ledger.attempts.push(attempt); ledger.used.providerSessions++; ledger.used.wallMs += ATTEMPT_RESERVE_MS;
    atomicWrite(path, ledger);
    let finished = false;
    return { id: attempt.id, grant: { id: attempt.id, scenario, parentPid: identity.ownerPid, nonce: identity.nonce }, finish({ wallMs, cleanClose, outcome }) {
      if (finished) return; finished = true;
      try {
        // Lost/timeout оставляют conservative reservation. Никакой автоматической recovery.
        if (cleanClose && Number.isFinite(wallMs) && wallMs >= 0 && wallMs <= ATTEMPT_RESERVE_MS) {
          const current = validate(read(path));
          const entry = current.attempts.find(a => a.id === attempt.id && a.state === 'reserved');
          if (!entry) fail('CLOUD_LEDGER_CORRUPT');
          const actual = Math.max(1, Math.ceil(wallMs));
          current.used.wallMs -= ATTEMPT_RESERVE_MS - actual;
          entry.state = 'closed'; entry.wallMs = actual;
          entry.outcome = ['closed','failed_connect','failed_case','stopped'].includes(outcome) ? outcome : 'stopped';
          atomicWrite(path, current);
        }
      } finally { held = false; release(); }
    } };
  } catch (error) { if (held) release(); throw error; }
}

// Claim-файл never-reuse, wx до SDK. IPC grant сам по себе не защищает от duplicate child.
export function claimBudget(path, id, scenario, grant) {
  const childPid = process.pid;
  const parentPid = process.ppid;
  const ledger = validate(read(path));
  const entry = ledger.attempts.find(a => a.id === id && a.scenario === scenario && a.state === 'reserved');
  let identity;
  try { identity = JSON.parse(readFileSync(`${path}.lock`, 'utf8')); }
  catch { fail('CLOUD_CHILD_GRANT_INVALID'); }
  if (!entry || grant?.id !== id || grant?.scenario !== scenario || grant?.parentPid !== parentPid || identity.ownerPid !== parentPid || identity.nonce !== grant?.nonce) fail('CLOUD_CHILD_GRANT_INVALID');
  try { process.kill(parentPid, 0); } catch { fail('CLOUD_PARENT_LOST'); }
  const claim = `${path}.${id}.claim`;
  let fd;
  try { fd = openSync(claim, 'wx', 0o600); }
  catch { fail('CLOUD_CHILD_ALREADY_CLAIMED'); }
  try { writeFileSync(fd, JSON.stringify({ id, scenario, childPid, parentPid })); fsyncSync(fd); }
  finally { closeSync(fd); }
  const dir = openSync(dirname(path), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
}
