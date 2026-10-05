// Watchdog принадлежит только запущенной нами process group. SDK в parent не загружается.
import { performance } from 'node:perf_hooks';

export async function runManagedChild({ spawnChild, hardMs = 90_000, workMs = 80_000, grant = undefined }) {
  const began = performance.now();
  let child;
  let closure;
  let forced = false;
  let stopped = false;
  let granted = false;
  const kill = signal => {
    if (!child?.pid) return;
    try { process.kill(-child.pid, signal); } catch {}
  };
  const requestStop = () => {
    stopped = true;
    if (child?.connected) { try { child.send({ type: 'stop' }, () => {}); } catch {} }
  };
  // Таймеры ставятся до spawn; child не может начать provider раньше watchdog.
  const work = setTimeout(requestStop, workMs);
  const hard = setTimeout(() => { forced = true; kill('SIGKILL'); }, hardMs);
  const onSignal = () => { requestStop(); kill('SIGTERM'); };
  process.once('SIGTERM', onSignal); process.once('SIGINT', onSignal);
  try {
    try { child = spawnChild(); }
    catch { return { cleanClose: true, outcome: 'failed_connect', wallMs: performance.now() - began }; }
    if (stopped) requestStop();
    child.on('message', message => {
      if (grant && !granted && !stopped && message?.type === 'request_grant' && message.id === grant.id && message.scenario === grant.scenario && message.pid === child.pid) {
        granted = true;
        try { child.send({ type: 'grant', ...grant }, () => {}); } catch { requestStop(); }
      }
      if (message?.type === 'closed' && typeof message.cleanClose === 'boolean' && ['closed','failed_connect','failed_case','stopped'].includes(message.outcome)) closure = { cleanClose: message.cleanClose, outcome: message.outcome };
    });
    child.on('error', () => {});
    await new Promise(resolve => child.once('close', resolve));
    return { cleanClose: !forced && closure?.cleanClose === true && child.exitCode === 0, outcome: closure?.outcome ?? 'child_lost', wallMs: performance.now() - began };
  } finally {
    clearTimeout(work); clearTimeout(hard);
    process.removeListener('SIGTERM', onSignal); process.removeListener('SIGINT', onSignal);
    if (child?.exitCode === null && child?.signalCode === null) kill('SIGKILL');
  }
}
