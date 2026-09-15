import type { LinkState, MicState } from '../hooks/useSession.ts';

type Props = { link: LinkState; mic: MicState; agentPresent: boolean; agentState: string; amplitude: number; onToggle: () => void };

export function voiceOrbPresentation(link: LinkState, agentPresent: boolean, agentState: string, mic: MicState) {
  const state = link !== 'connected' || !agentPresent ? 'connecting' : agentState === 'speaking' ? 'speaking' : agentState === 'thinking' ? 'thinking' : mic === 'on' ? 'listening' : 'idle';
  const labels: Record<string, string> = { connecting: link === 'connected' ? 'Жду Гоко' : 'Соединяюсь', listening: 'Слушаю', thinking: 'Гоко готовит ответ', speaking: 'Гоко говорит', idle: 'Гоко рядом' };
  return { state, label: labels[state]! };
}

export function VoiceOrb({ link, mic, agentPresent, agentState, amplitude, onToggle }: Props) {
  const { state, label } = voiceOrbPresentation(link, agentPresent, agentState, mic);
  return (
    <button type="button" className={`voice-orb voice-orb-${state}`} style={{ '--level': Math.min(1, Math.max(0, amplitude)) } as React.CSSProperties} onClick={onToggle} aria-label={`${label}. ${mic === 'on' ? 'Выключить микрофон' : 'Включить микрофон'}`} aria-pressed={mic === 'on'}>
      <span className="voice-orb-core" aria-hidden="true" />
      <span className="voice-orb-label">{label}</span>
    </button>
  );
}
