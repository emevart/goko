import type { LinkState, MicState } from '../hooks/useSession.ts';

type Props = { link: LinkState; mic: MicState; agentPresent: boolean; agentState: string; toolState?: string; amplitude: number; onToggle: () => void };

export function voiceOrbPresentation(link: LinkState, agentPresent: boolean, agentState: string, mic: MicState, toolState = 'idle') {
  const state = link !== 'connected' || !agentPresent
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
  const labels: Record<string, string> = {
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

export function VoiceOrb({ link, mic, agentPresent, agentState, toolState = 'idle', amplitude, onToggle }: Props) {
  const { state, label } = voiceOrbPresentation(link, agentPresent, agentState, mic, toolState);
  return (
    <button type="button" className={`voice-orb voice-orb-${state}`} style={{ '--level': Math.min(1, Math.max(0, amplitude)) } as React.CSSProperties} onClick={onToggle} aria-label={`${label}. ${mic === 'on' ? 'Выключить микрофон' : 'Включить микрофон'}`} aria-pressed={mic === 'on'}>
      <span className="voice-orb-core" aria-hidden="true" />
      <span className="voice-orb-label">{label}</span>
    </button>
  );
}
