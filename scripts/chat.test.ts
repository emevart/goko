import { describe, expect, it } from 'vitest';
import { ApiError, ClientTimeoutError, humanText } from '@goko/protocol';
import { CHAT_ATTRIBUTES, describeEvent, disconnectOutcome, fatalLine, waitForQuiet, waitWarning } from './chat.mjs';

// Часы и пауза подделаны: время идёт только в pause.
function fakeClock() {
  const clock = { t: 0, pauses: 0 };
  return {
    clock,
    now: () => clock.t,
    pause: async (ms: number) => {
      clock.pauses += 1;
      clock.t += ms;
    },
  };
}

describe('CHAT_ATTRIBUTES', () => {
  it('консоль — режим «Чат» (D-0011): агент отвечает текстом, без звука', () => {
    expect(CHAT_ATTRIBUTES).toEqual({ 'goko.mode': 'chat' });
  });
});

describe('describeEvent', () => {
  it('коротко описывает события сессии', () => {
    expect(describeEvent({ type: 'session.game', gameId: 'g1' })).toBe('партия g1');
    expect(describeEvent({ type: 'engine.thinking', gameId: 'g1', color: 'W' })).toBe('Гоко думает за W');
    expect(describeEvent({ type: 'game.finished', result: { winner: 'W', reason: 'resign' } })).toBe('конец: W+R');
    expect(describeEvent({ type: 'game.finished', result: { winner: 'B', margin: 5.5, reason: 'score' } })).toBe('конец: B+5.5');
    expect(describeEvent({ type: 'error', gameId: 'g1', code: 'engine_busy', message: 'engine did not respond within 8000 ms' })).toBe('ошибка engine_busy: Гоко думает дольше обычного');
    expect(
      describeEvent({
        type: 'state.updated',
        cause: 'engine',
        by: 'engine',
        state: { revision: 4, toPlay: 'B', moves: [{ n: 1, color: 'B', coord: 'D4' }, { n: 2, color: 'W', coord: 'K10' }] },
      }),
    ).toBe('engine by engine: ход 2 W K10, rev 4, дальше B');
    expect(describeEvent({ type: 'state.updated', cause: 'play', by: 'human', via: 'tap', state: { revision: 1, toPlay: 'W', moves: [] } })).toBe(
      'play by human via tap: ходов 0, rev 1, дальше W',
    );
  });
});

describe('waitForQuiet: тишина перед выходом и перед следующей строкой сценария', () => {
  it('уже тихо — quiet сразу, без паузы', async () => {
    const { clock, now, pause } = fakeClock();
    const outcome = await waitForQuiet(() => ({ busy: false, lastActivityAt: -5000 }), { quietMs: 1000, maxWaitMs: 3000, pollMs: 200, now, pause });
    expect(outcome).toBe('quiet');
    expect(clock.pauses).toBe(0);
  });

  it('ждёт quietMs от последней активности; новая активность отодвигает тишину', async () => {
    const { clock, now, pause } = fakeClock();
    let lastActivityAt = 0;
    const probe = () => {
      if (clock.t === 400) lastActivityAt = 400;
      return { busy: false, lastActivityAt };
    };
    expect(await waitForQuiet(probe, { quietMs: 1000, maxWaitMs: 5000, pollMs: 200, now, pause })).toBe('quiet');
    expect(clock.t).toBe(1400);
  });

  it('открытый поток или неподтверждённый сегмент — не тишина, даже если активность давно', async () => {
    const { clock, now, pause } = fakeClock();
    const probe = () => ({ busy: clock.t < 2000, lastActivityAt: -10000 });
    expect(await waitForQuiet(probe, { quietMs: 1000, maxWaitMs: 5000, pollMs: 200, now, pause })).toBe('quiet');
    expect(clock.t).toBe(2000);
  });

  it('потолок maxWaitMs при занятом потоке — busy, дальше не ждёт', async () => {
    const { clock, now, pause } = fakeClock();
    expect(await waitForQuiet(() => ({ busy: true, lastActivityAt: 0 }), { quietMs: 1000, maxWaitMs: 3000, pollMs: 200, now, pause })).toBe('busy');
    expect(clock.t).toBe(3000);
  });

  it('ответ ещё не начался — тишина дольше quietMs не считается ответом, строка ждёт начала потока', async () => {
    const { clock, now, pause } = fakeClock();
    // Отправили в t=0; вызов инструмента молчит 8 с, поток ответа открывается в t=8000 и закрывается в t=9000.
    const probe = () => {
      const replied = clock.t >= 8000;
      const busy = clock.t >= 8000 && clock.t < 9000;
      const lastActivityAt = clock.t >= 9000 ? 9000 : clock.t >= 8000 ? clock.t : 0;
      return { busy, lastActivityAt, replied };
    };
    expect(await waitForQuiet(probe, { quietMs: 5000, maxWaitMs: 60000, pollMs: 200, now, pause })).toBe('quiet');
    expect(clock.t).toBe(14000);
  });

  it('ответ не начался до потолка — no_reply, а не quiet', async () => {
    const { clock, now, pause } = fakeClock();
    const probe = () => ({ busy: false, lastActivityAt: 0, replied: false });
    expect(await waitForQuiet(probe, { quietMs: 1000, maxWaitMs: 3000, pollMs: 200, now, pause })).toBe('no_reply');
    expect(clock.t).toBe(3000);
  });

  it('общий дедлайн прогона обрывает ожидание раньше maxWaitMs', async () => {
    const { clock, now, pause } = fakeClock();
    expect(await waitForQuiet(() => ({ busy: true, lastActivityAt: 0 }), { quietMs: 1000, maxWaitMs: 60000, deadline: 2000, pollMs: 200, now, pause })).toBe('busy');
    expect(clock.t).toBe(2000);
    // Дедлайн уже прошёл, но тишина есть — тишина важнее: хвост ответа не обрываем.
    expect(await waitForQuiet(() => ({ busy: false, lastActivityAt: -5000 }), { quietMs: 1000, maxWaitMs: 60000, deadline: 0, pollMs: 200, now, pause })).toBe('quiet');
  });
});

describe('waitWarning: строка [!] для ожидания, кончившегося не тишиной', () => {
  it('тишина — строки нет', () => {
    expect(waitWarning('quiet', { lastSent: 'дэ четыре', waitedMs: 1200, then: 'отправляю следующую строку' })).toBeNull();
  });

  it('ответ не начался — называет фразу и время', () => {
    expect(waitWarning('no_reply', { lastSent: 'кто впереди', waitedMs: 60000, then: 'закрываю сессию' })).toBe('[!] ответа на «кто впереди» не дождался за 60 с, закрываю сессию');
  });

  it('поток не закрылся — тишины не дождался', () => {
    expect(waitWarning('busy', { lastSent: 'дэ четыре', waitedMs: 59600, then: 'отправляю следующую строку' })).toBe('[!] тишины не дождался за 60 с, отправляю следующую строку');
  });
});

describe('disconnectOutcome: отключение от комнаты', () => {
  it('своё отключение (shutdown уже идёт) — ничего не делаем', () => {
    expect(disconnectOutcome(true)).toBeNull();
  });

  it('чужое отключение — сбой LiveKit: код 1 и строка [X] без адреса', () => {
    expect(disconnectOutcome(false)).toEqual({ code: 1, line: '[X] соединение с LiveKit потеряно, комната закрыта' });
  });
});

describe('fatalLine: текст сбоя соответствует этапу', () => {
  it('до сессии: ответ по протоколу — humanText и код', () => {
    const e = new ApiError('rate_limited', 'too many requests, retry in 7 s', { retryAfterSeconds: 7 });
    expect(fatalLine(e, false)).toBe(`[X] chat: не удалось создать сессию: ${humanText('rate_limited', { retryAfterSeconds: 7 })} (rate_limited)`);
    expect(fatalLine(new ClientTimeoutError('create_session', 15000), false)).toBe('[X] chat: не удалось создать сессию: сервер не отвечает (client_timeout)');
  });

  it('до сессии: прочее — своя строка без текста ошибки', () => {
    const line = fatalLine(new TypeError('fetch failed: connect ECONNREFUSED 10.0.0.1:8787'), false);
    expect(line).toBe('[X] chat: не удалось создать сессию; проверьте --api, APP_KEY и запущенный game-server');
  });

  it('после создания сессии — другой текст, только имя класса ошибки', () => {
    const line = fatalLine(new TypeError('secret wss://lk.example/?token=abc'), true);
    expect(line).toBe('[X] chat: сбой после создания сессии (TypeError), выхожу');
    expect(fatalLine(new ApiError('internal', 'boom'), true)).toBe('[X] chat: сбой после создания сессии (ApiError), выхожу');
    expect(fatalLine('строка', true)).toBe('[X] chat: сбой после создания сессии (string), выхожу');
  });
});
