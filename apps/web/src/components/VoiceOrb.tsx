import type { LinkState, MicState } from '../hooks/useSession.ts';
import { VoiceOrb3D } from './VoiceOrb3D.tsx';
import type { OrbState } from '../orb.ts';

type Props = { link: LinkState; mic: MicState; agentPresent: boolean; agentState: string; toolState?: string; micLevel: number; agentLevel: number; onToggle: () => void };

export function voiceOrbPresentation(link: LinkState, agentPresent: boolean, agentState: string, mic: MicState, toolState = 'idle'): { state: OrbState; label: string } {
  const state: OrbState = link !== 'connected' || !agentPresent
    ? 'connecting'
    : toolState !== 'idle'
      ? 'tool'
      : agentState === 'speaking'
        ? 'speaking'
        : agentState === 'thinking'
          ? 'thinking'
          : mic === 'connecting'
            ? 'connecting'
            : mic === 'failed'
              ? 'error'
              : mic === 'on'
                ? 'listening'
                : 'muted';
  const labels: Record<OrbState, string> = {
    connecting: link !== 'connected' ? 'Соединяюсь' : !agentPresent ? 'Жду Гоко' : mic === 'connecting' ? 'Включаю микрофон' : 'Подключаю голос',
    listening: 'Слушаю',
    thinking: 'Гоко думает',
    speaking: 'Гоко говорит',
    tool: toolState === 'get_position' ? 'Сверяю доску' : toolState === 'get_assessment' ? 'Оцениваю позицию' : 'Работаю с доской',
    error: 'Микрофон недоступен',
    muted: 'Микрофон выключен',
  };
  return { state, label: labels[state]! };
}

export function voiceOrbLevel(state: OrbState, micLevel: number, agentLevel: number): number {
  const active = state === 'speaking' ? agentLevel : state === 'listening' ? micLevel : 0;
  return Math.min(1, Math.max(0, Number.isFinite(active) ? active : 0));
}

export function VoiceOrb({ link, mic, agentPresent, agentState, toolState = 'idle', micLevel, agentLevel, onToggle }: Props) {
  const { state, label } = voiceOrbPresentation(link, agentPresent, agentState, mic, toolState);
  const level = voiceOrbLevel(state, micLevel, agentLevel);
  return (
    <button type="button" className={`voice-orb voice-orb-${state}`} style={{ '--level': Math.min(1, Math.max(0, level)) } as React.CSSProperties} onClick={onToggle} aria-label={`${label}. ${mic === 'on' ? 'Выключить микрофон' : 'Включить микрофон'}`} aria-pressed={mic === 'on'}>
      <span className="voice-orb-visual" aria-hidden="true">
        <VoiceOrb3D state={state} level={level} />
      </span>
      <span className="voice-orb-label">{label}</span>
    </button>
  );
}
