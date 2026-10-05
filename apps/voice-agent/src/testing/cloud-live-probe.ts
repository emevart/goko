// Только отдельный Cloud child. SDK ESM из этого workspace импортируется ПОСЛЕ adapter.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { installCloudLiveTransport, verifyCloudLiveSDK, safeFailure } from '../../../../scripts/cloud-live-transport.mjs';
import { claimBudget } from '../../../../scripts/cloud-live-budget.mjs';
import { ProbeLifecycle } from './cloud-live-lifecycle.ts';
import { createProbeGame, PCMRecorder, scenarios, type ProbeCase } from './cloud-live-fixtures.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
// Latching abort установлен до ожидания grant и любых SDK imports.
const startupAbort = new AbortController();
const abortStartup = () => startupAbort.abort(new Error('CLOUD_PARENT_LOST'));
process.once('disconnect', abortStartup);
process.once('SIGTERM', abortStartup); process.once('SIGINT', abortStartup);
// Даже pending async SDK import при потерянном parent ограничен собственным hard deadline.
const earlyHard = process.connected ? setTimeout(() => { abortStartup(); process.exit(1); }, 87_000) : undefined;
type CaseResult = { kind: ProbeCase['kind']; input: string; status: 'observed' | 'failed' | 'unrun'; textVerdict: 'manual_review'; before?: unknown; after?: unknown; calls?: unknown; tools?: string[]; backendText?: string; voiceText?: string; atMs?: number; elapsedMs?: number };
async function run(id: string, scenario: keyof typeof scenarios): Promise<void> {
  const began = performance.now();
  const now = () => performance.now() - began;
  const failures: Array<{ class: string; status?: number }> = [];
  const adapter = installCloudLiveTransport({ authorized: true, onFailure: value => { if (failures.length < 12) failures.push(value); } });
  const abort = startupAbort;
  const game = createProbeGame(scenario === 'facts' || scenario === 'ambiguity');
  const pcm = new PCMRecorder();
  const cases: CaseResult[] = scenarios[scenario].map(c => ({ kind: c.kind, input: c.text, status: 'unrun', textVerdict: 'manual_review' }));
  let activeCase: CaseResult | undefined;
  let clock: { stop(): void; setInputEnabled(enabled: boolean): void } | undefined;
  let coordinator: import('../live-response.ts').LiveResponseCoordinator | undefined;
  let agentSession: import('@livekit/agents').voice.AgentSession | undefined;
  let lifecycle: ProbeLifecycle | undefined;
  let outcome: 'closed' | 'failed_connect' | 'failed_case' | 'stopped' = 'failed_connect';
  let cleanClose = false;
  let providerStarted = 0;
  let reconnected = 0;
  let providerUsageSeconds: number | undefined;
  let resolveStarted: () => void = () => {};
  const started = new Promise<void>(resolve => { resolveStarted = resolve; });
  const stop = () => { lifecycle?.stop(); if (!abort.signal.aborted) abort.abort(new Error('CLOUD_PROBE_STOPPED')); };
  process.on('message', message => { if ((message as { type?: string })?.type === 'stop') stop(); });
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  abort.signal.addEventListener('abort', () => { lifecycle?.stop(); clock?.stop(); coordinator?.stop(); }, { once: true });
  try {
    const [{ voice, initializeLogger }, openai, { GokoAgent }, { createTools }, { IntentLedger }, { LiveBridge }, { LiveResponseCoordinator }, { LiveSilenceClock }, { GPT_LIVE_MODEL_OPTIONS }] = await Promise.all([
      import('@livekit/agents'), import('@livekit/agents-plugin-openai'), import('../agent.ts'), import('../tools.ts'), import('../intent.ts'), import('../live-bridge.ts'), import('../live-response.ts'), import('../live-clock.ts'), import('../voice.ts'),
    ]);
    initializeLogger({ pretty: false, level: 'silent' });
    if (abort.signal.aborted || !process.connected) throw new Error('CLOUD_PARENT_LOST');
    lifecycle = new ProbeLifecycle({ abort, closeAgent: () => agentSession?.close() ?? Promise.resolve(), closeTransport: () => adapter.close(), workMs: Math.max(1, 80_000 - now()) });
    class ProbeModel extends openai.realtime.GPTLiveModel {
      private used = false;
      override session() {
        if (this.used || abort.signal.aborted) throw new Error('CLOUD_PROVIDER_USED');
        this.used = true;
        const provider = super.session();
        // super только планирует main на microtask. Все guards/listeners стоят до него.
        lifecycle!.attach(provider as unknown as Parameters<ProbeLifecycle['attach']>[0]);
        provider.on('session_reconnected', () => { reconnected++; stop(); });
        provider.on('openai_server_event_received', event => {
          if (event.type === 'session.started') { providerStarted++; if (providerStarted > 1) stop(); resolveStarted(); }
          if (event.type === 'session.output_audio.delta') pcm.append(event.delta ?? '', now());
          if ('usage' in event && typeof event.usage?.seconds === 'number') providerUsageSeconds = event.usage.seconds;
          if (event.type === 'error') { if (failures.length < 12) failures.push({ class: 'CLOUD_PROVIDER_ERROR' }); }
          if (activeCase && event.type === 'response.event') {
            const inner = event.event;
            if (inner?.type === 'response.output_text.delta' && 'delta' in inner && typeof inner.delta === 'string') activeCase.backendText = bounded((activeCase.backendText ?? '') + inner.delta);
          }
          if (activeCase && event.type === 'session.output_transcript.delta') activeCase.voiceText = bounded((activeCase.voiceText ?? '') + (event.delta ?? ''));
        });
        return provider;
      }
    }
    const model = new ProbeModel({ ...GPT_LIVE_MODEL_OPTIONS, maxSessionDuration: null, connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 10_000 } });
    const intent = new IntentLedger();
    const tools = createTools({ client: game.client, state: game.state, intent, signal: abort.signal, onToolStateChange: (busy, name) => { if (busy && activeCase && (activeCase.tools?.length ?? 0) < 16) (activeCase.tools ??= []).push(name); }, log: () => {} });
    const agent = new GokoAgent(tools, { greet: false });
    agentSession = new voice.AgentSession({ llm: model });
    const Events = voice.AgentSessionEventTypes;
    agentSession.on(Events.AgentStateChanged, ev => coordinator?.noteAgentState(ev.newState));
    agentSession.on(Events.UserStateChanged, ev => coordinator?.noteUserState(ev.newState));
    agentSession.on(Events.ConversationItemAdded, ev => { if (ev.item.type === 'message' && ev.item.role === 'assistant' && ev.item.textContent) coordinator?.noteAssistant(ev.item.textContent); });
    agentSession.on(Events.Close, () => stop());
    if (abort.signal.aborted || !process.connected) throw new Error('CLOUD_PARENT_LOST');
    await lifecycle.start(async () => { await agentSession!.start({ agent, record: false }); await started; });
    const provider = agent.duplexSession as unknown as import('../live-bridge.ts').LiveWire & import('../live-clock.ts').LiveAudioProvider & import('../live-response.ts').LiveEventSource;
    coordinator = new LiveResponseCoordinator({ live: provider, signal: abort.signal, timeoutMs: 30_000 });
    coordinator.noteUserState(agentSession.userState); coordinator.noteAgentState(agentSession.agentState);
    const bridge = new LiveBridge({ live: provider, intent, waitUntilReady: () => coordinator!.waitUntilIdle(), waitForReply: kind => coordinator!.waitForReply(kind) });
    clock = new LiveSilenceClock(provider); clock.setInputEnabled(false);
    outcome = 'closed';
    for (let i = 0; i < cases.length; i++) {
      if (abort.signal.aborted || now() >= 75_000) break;
      const selected = cases[i]!;
      activeCase = selected; selected.atMs = now(); selected.before = game.snapshot();
      const callStart = game.client.calls.length;
      try {
        await bridge.typed(selected.input);
        selected.after = game.snapshot(); selected.calls = structuredClone(game.client.calls.slice(callStart));
        const before = selected.before as import('@goko/protocol').GameState;
        const after = selected.after as import('@goko/protocol').GameState;
        const names = selected.tools ?? [];
        const unchanged = JSON.stringify(before) === JSON.stringify(after);
        const text = (selected.backendText ?? '') + (selected.voiceText ?? '');
        const valid = selected.kind === 'play'
          ? names.filter(n => n === 'play_move').length === 1 && after.moves.length === 2 && after.moves[0]?.coord === 'D4' && after.moves[1]?.coord === 'K10'
          : selected.kind === 'repeat' ? unchanged && names.length === 1 && names[0] === 'repeat_last_move' && game.client.calls.slice(callStart).every(c=>c.method==='getGame')
          : selected.kind === 'ambiguity' ? unchanged && text.trim().length > 0 && !names.some(n => ['play_move','correct_last_move','redo'].includes(n))
          : unchanged && text.trim().length > 0;
        selected.status = valid ? 'observed' : 'failed';
        if (!valid) outcome = 'failed_case';
      } catch {
        selected.status = 'failed'; selected.after = game.snapshot(); selected.calls = structuredClone(game.client.calls.slice(callStart)); outcome = 'failed_case';
        break;
      } finally { selected.elapsedMs = now() - selected.atMs!; activeCase = undefined; }
    }
  } catch (error) { if (failures.length < 12) failures.push(safeFailure(error)); }
  finally {
    if (lifecycle) cleanClose = await lifecycle.close(); else { adapter.close(); cleanClose = true; }
    clock?.stop(); coordinator?.stop();
    // При hanging close guards остаются закрытыми до process exit.
    if (cleanClose) adapter.uninstall();
    const prefix = join(root, '.agent-artifacts/cloud-product/voice', id);
    try {
      writeFileSync(prefix + '.pcm', pcm.pcm(), { mode: 0o600 });
      writeFileSync(prefix + '.wav', pcm.wav(), { mode: 0o600 });
      writeFileSync(prefix + '.json', JSON.stringify({ scenario, outcome, cleanClose, elapsedMs: now(), providerStarted, reconnected, handshakes: adapter.handshakes, providerUsageSeconds, failures, cases, caseStatusMeaning: 'observed = completed round-trip and structural tools/state assertions only', textVerdict: 'manual_review: grounding/ambiguity wording/future-move leakage/ordinary tone', naturalness: 'manual WAV listening required', audio: pcm.metadata(), input: 'typed', stt: 'unrun', audioInput: 'unrun', phone: 'unrun', engine: 'fixed testing fake K10; go-core replay' }, null, 2) + '\n', { mode: 0o600 });
    } catch { cleanClose = false; }
    if (process.connected) process.send?.({ type: 'closed', cleanClose, outcome }, () => { process.disconnect?.(); });
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
    // Native SDK handles не переживают child; отчёт отправлен только после bounded close.
    setTimeout(() => process.exit(cleanClose ? 0 : 1), 20);
  }
}
function bounded(text: string) { return text.slice(0, 8_000); }
try {
  const args = process.argv.slice(2);
  if (Number(process.versions.node.split('.')[0]) !== 24 || !process.send || !process.connected || args.length !== 3 || args[0] !== '--child' || !/^[a-f0-9-]{36}$/.test(args[1]!) || !Object.hasOwn(scenarios, args[2]!)) throw new Error('CLOUD_CHILD_UNAUTHORIZED');
  const grant = await new Promise<Record<string, unknown>>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const finish = (value?: Record<string, unknown>) => { clearTimeout(timer); process.removeListener('message', onMessage); startupAbort.signal.removeEventListener('abort', onAbort); if (value) resolve(value); else reject(new Error('CLOUD_CHILD_UNAUTHORIZED')); };
    const onAbort = () => finish();
    const onMessage = (message: unknown) => {
      if (message && typeof message === 'object') {
        const value = message as Record<string, unknown>;
        if (value.type === 'stop') abortStartup();
        if (value.type === 'grant' && value.id === args[1] && value.scenario === args[2]) finish(value);
      }
    };
    process.on('message', onMessage); startupAbort.signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(onAbort, 5_000);
    if (startupAbort.signal.aborted || !process.connected) onAbort();
    else process.send!({ type: 'request_grant', id: args[1], scenario: args[2], pid: process.pid }, error => { if (error) abortStartup(); });
  });
  if (startupAbort.signal.aborted || !process.connected) throw new Error('CLOUD_PARENT_LOST');
  claimBudget(join(root, '.agent-artifacts/cloud-product/voice-budget.json'), args[1], args[2], grant);
  verifyCloudLiveSDK(root);
  await run(args[1]!, args[2] as keyof typeof scenarios);
} catch {
  console.log(JSON.stringify({ status: 'inconclusive', class: 'CLOUD_CHILD_UNAUTHORIZED', providerAttempts: 0 })); process.exitCode = 2;
  if (process.connected) process.disconnect?.();
} finally { clearTimeout(earlyHard); }
