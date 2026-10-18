// Opt-in paid Cloud smoke. Default/dry только читает установленный source, API=0.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { initializeBudget, reserveBudget } from './cloud-live-budget.mjs';
import { verifyCloudLiveSDK, safeFailure, CloudProbeError } from './cloud-live-transport.mjs';
import { runManagedChild } from './cloud-live-managed-child.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ledger = join(root, '.agent-artifacts/cloud-product/voice-budget.json');
const outputDir = join(root, '.agent-artifacts/cloud-product/voice');
let budgetSlotReserved = false;
const fail = code => { throw new CloudProbeError(code); };
async function main(args) {
  if (!args.length || (args.length === 1 && args[0] === '--dry')) {
    if (Number(process.versions.node.split('.')[0]) !== 24) return { status: 'offline_dry', providerAttempts: 0, networkCalls: 0, liveGate: 'unsupported_node' };
    return { status: 'offline_dry', providerAttempts: 0, networkCalls: 0, sdk: verifyCloudLiveSDK(root), liveGate: 'offline_only' };
  }
  if (args.length === 1 && args[0] === '--initialize-zero-audit') {
    initializeBudget(ledger); return { status: 'zero_audit_migrated', providerAttempts: 0, networkCalls: 0 };
  }
  if (args.length !== 3 || args[0] !== '--run' || args[1] !== '--scenario' || !['first','ambiguity','facts','repair'].includes(args[2])) fail('CLOUD_ARGUMENT');
  if (Number(process.versions.node.split('.')[0]) !== 24) fail('CLOUD_UNSUPPORTED_NODE');
  if (process.platform !== 'linux') fail('CLOUD_UNSUPPORTED_PLATFORM');
  // Не изменяем inherited env; небезопасные overrides/debug требуют отдельной диагностики.
  if (process.env.NODE_DEBUG || process.env.NODE_DEBUG_NATIVE || process.env.NODE_OPTIONS || process.env.LK_OPENAI_DEBUG || process.env.OPENAI_BASE_URL || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') fail('CLOUD_UNSAFE_RUNTIME');
  if (!Object.hasOwn(process.env, 'OPENAI_API_KEY')) fail('CLOUD_BINDING_MISSING');
  verifyCloudLiveSDK(root);
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const reservation = reserveBudget(ledger, args[2]);
  budgetSlotReserved = true;
  let result = { cleanClose: false, outcome: 'child_lost', wallMs: 90_000 };
  try {
    result = await runManagedChild({ grant: reservation.grant, spawnChild: () => spawn(process.execPath, ['--use-env-proxy', join(root, 'apps/voice-agent/src/testing/cloud-live-probe.ts'), '--child', reservation.id, args[2]], {
      cwd: root, env: process.env, detached: true,
      // Raw stdout/stderr SDK никогда не перепечатываются и не сохраняются.
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    }) });
  } finally { reservation.finish(result); }
  return { status: 'attempt_finished', ...result, artifact: `.agent-artifacts/cloud-product/voice/${reservation.id}.json`, audio: `.agent-artifacts/cloud-product/voice/${reservation.id}.wav` };
}
try { console.log(JSON.stringify(await main(process.argv.slice(2)))); }
catch (error) { console.log(JSON.stringify({ status: 'inconclusive', ...safeFailure(error), budgetSlotReserved, providerAttempts: budgetSlotReserved ? 'unknown' : 0 })); process.exitCode = 2; }
