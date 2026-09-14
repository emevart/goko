import type { LinkState, MicState } from '../hooks/useSession.ts';

type Props = { link: LinkState; mic: MicState; agentState: string; amplitude: number };

export function VoiceOrb({ link, mic, agentState, amplitude }: Props) {
  const state = link !== 'connected' ? 'connecting' : agentState === 'speaking' ? 'speaking' : agentState === 'thinking' ? 'thinking' : mic === 'on' ? 'listening' : 'idle';
  const labels: Record<string, string> = { connecting: 'Соединяюсь', listening: 'Слушаю', thinking: 'Гоко готовит ответ', speaking: 'Гоко говорит', idle: 'Гоко рядом' };
  return (
    <div className={`voice-orb voice-orb-${state}`} style={{ '--level': Math.min(1, Math.max(0, amplitude)) } as React.CSSProperties} role="status" aria-label={labels[state]}>
      <span className="voice-orb-core" aria-hidden="true" />
      <span className="voice-orb-label">{labels[state]}</span>
    </div>
  );
}
