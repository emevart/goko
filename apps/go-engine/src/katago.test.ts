import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KataGo, KataGoError, type KataProcess } from './katago.ts';

type Reply = (r: unknown) => void;
type Handler = (query: Record<string, unknown>, reply: Reply, spawnIndex: number) => void;

type Spawned = {
  proc: KataProcess;
  stdout: PassThrough;
  stderr: PassThrough;
  exit: (code: number | null) => void;
  written: string[];
  bin: string;
  args: string[];
  kills: number;
};

// Индексация без восклицательных знаков: отсутствие элемента должно падать внятно.
function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) throw new Error(`no element at index ${index}`);
  return value;
}

// Подделка процесса KataGo: читает JSON-строки из stdin, отвечает через handler в stdout.
function fakeSpawner(handler: Handler) {
  const spawned: Spawned[] = [];
  const spawn = (bin: string, args: string[]): KataProcess => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const listeners: Array<(code: number | null) => void> = [];
    const written: string[] = [];
    const index = spawned.length;
    const entry: Spawned = {
      proc: {
        stdin,
        stdout,
        stderr,
        kill: () => {
          entry.kills++;
          for (const l of [...listeners]) l(0);
        },
        on: (_event, cb) => {
          listeners.push(cb);
        },
      },
      stdout,
      stderr,
      exit: (code) => {
        for (const l of [...listeners]) l(code);
      },
      written,
      bin,
      args,
      kills: 0,
    };
    readline.createInterface({ input: stdin }).on('line', (line) => {
      written.push(line);
      handler(JSON.parse(line) as Record<string, unknown>, (r) => stdout.write(`${JSON.stringify(r)}\n`), index);
    });
    spawned.push(entry);
    return entry.proc;
  };
  return { spawn, spawned };
}

// Ждём только доставку данных потоками (nextTick/setImmediate), время двигаем вручную.
const tick = async (): Promise<void> => {
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));
};

// Наблюдение за промисом без ожидания: нужен ответ «уже завершился или ещё нет».
function track<T>(p: Promise<T>): { settled: boolean } {
  const state = { settled: false };
  p.then(
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
    },
  );
  return state;
}

const opts = { bin: 'katago', model: 'main', humanModel: 'human', config: 'cfg', backoffMs: [10] };

beforeEach(() => {
  // Фейковые только таймеры и часы: доставка потоков остаётся настоящей, тесты не спят.
  // Date нужен потому, что дедлайн запроса — момент времени, а не только заведённый таймер.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('KataGo', () => {
  it('запрос получает id и ответ с тем же id', async () => {
    const f = fakeSpawner((q, reply) => reply({ id: q.id, rootInfo: { winrate: 0.5 }, echo: q.maxVisits }));
    const k = new KataGo({ ...opts, spawn: f.spawn });
    k.start();
    const r = await k.query({ maxVisits: 7 });
    expect(r.id).toBe('q1');
    expect(r.echo).toBe(7);
    const s = at(f.spawned, 0);
    expect(JSON.parse(at(s.written, 0))).toEqual({ id: 'q1', maxVisits: 7 });
    expect(s.written).toHaveLength(1);
    // таймаут снят вместе с ответом: висящий таймер держал бы процесс живым
    expect(vi.getTimerCount()).toBe(0);
    await k.stop();
  });

  it('процесс запускается в режиме анализа с путями из опций', async () => {
    const f = fakeSpawner(() => undefined);
    const k = new KataGo({ ...opts, spawn: f.spawn });
    k.start();
    const s = at(f.spawned, 0);
    expect(s.bin).toBe('katago');
    expect(s.args).toEqual(['analysis', '-config', 'cfg', '-model', 'main', '-human-model', 'human']);
    await k.stop();
  });

  it('ответ с error отклоняет запрос, warning — нет', async () => {
    const f = fakeSpawner((q, reply) => {
      if (q.bad) reply({ id: q.id, error: 'bad field', field: 'moves' });
      else {
        reply({ id: q.id, warning: 'meh', field: 'rules' });
        reply({ id: q.id, rootInfo: {} });
      }
    });
    const k = new KataGo({ ...opts, spawn: f.spawn });
    k.start();
    await expect(k.query({ bad: true })).rejects.toMatchObject({ kind: 'rejected' });
    await expect(k.query({})).resolves.toMatchObject({ id: 'q2' });
    await k.stop();
  });

  it('не более maxConcurrent запросов в полёте, остальные ждут', async () => {
    const pending: Reply[] = [];
    const f = fakeSpawner((q, reply) => pending.push(() => reply({ id: q.id })));
    const k = new KataGo({ ...opts, spawn: f.spawn, maxConcurrent: 1 });
    k.start();
    const a = k.query({ n: 1 });
    const b = k.query({ n: 2 });
    await tick();
    const s = at(f.spawned, 0);
    expect(s.written).toHaveLength(1);
    expect(k.queueLength).toBe(2);
    at(pending, 0)(undefined);
    await a;
    await tick();
    expect(s.written).toHaveLength(2);
    expect(k.queueLength).toBe(1);
    at(pending, 1)(undefined);
    await b;
    expect(k.queueLength).toBe(0);
    await k.stop();
  });

  it('maxConcurrent по умолчанию — один запрос в полёте', async () => {
    const f = fakeSpawner(() => undefined);
    const k = new KataGo({ ...opts, spawn: f.spawn });
    k.start();
    track(k.query({ n: 1 }));
    track(k.query({ n: 2 }));
    await tick();
    expect(at(f.spawned, 0).written).toHaveLength(1);
    await k.stop();
  });

  it('maxConcurrent 2: два в полёте, третий ждёт', async () => {
    const pending: Reply[] = [];
    const f = fakeSpawner((q, reply) => pending.push(() => reply({ id: q.id })));
    const k = new KataGo({ ...opts, spawn: f.spawn, maxConcurrent: 2 });
    k.start();
    const a = k.query({ n: 1 });
    const b = k.query({ n: 2 });
    const c = k.query({ n: 3 });
    await tick();
    const s = at(f.spawned, 0);
    expect(s.written).toHaveLength(2);
    expect(k.queueLength).toBe(3);
    at(pending, 0)(undefined);
    await a;
    await tick();
    expect(s.written).toHaveLength(3);
    at(pending, 1)(undefined);
    at(pending, 2)(undefined);
    await b;
    await c;
    expect(k.queueLength).toBe(0);
    await k.stop();
  });

  it('ответы в обратном порядке достаются своим запросам по id', async () => {
    const seen: string[] = [];
    const f = fakeSpawner((q) => seen.push(String(q.id)));
    const k = new KataGo({ ...opts, spawn: f.spawn, maxConcurrent: 2 });
    k.start();
    const a = k.query({ n: 1 });
    const b = k.query({ n: 2 });
    await tick();
    expect(seen).toEqual(['q1', 'q2']);
    const out = at(f.spawned, 0).stdout;
    out.write(`${JSON.stringify({ id: 'q2', n: 2 })}\n`);
    out.write(`${JSON.stringify({ id: 'q1', n: 1 })}\n`);
    expect(await a).toMatchObject({ id: 'q1', n: 1 });
    expect(await b).toMatchObject({ id: 'q2', n: 2 });
    await k.stop();
  });

  it('таймаут срабатывает ровно на границе и шлёт terminate', async () => {
    const f = fakeSpawner(() => undefined);
    const k = new KataGo({ ...opts, spawn: f.spawn });
    k.start();
    const p = k.query({}, 20);
    const state = track(p);
    await vi.advanceTimersByTimeAsync(19);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.settled).toBe(true);
    await expect(p).rejects.toBeInstanceOf(KataGoError);
    await expect(p).rejects.toMatchObject({ kind: 'timeout' });
    const s = at(f.spawned, 0);
    expect(JSON.parse(at(s.written, 1))).toEqual({ id: 't-q1', action: 'terminate', terminateId: 'q1' });
    await k.stop();
  });

  it('таймаут по умолчанию — тридцать секунд', async () => {
    const f = fakeSpawner(() => undefined);
    const k = new KataGo({ ...opts, spawn: f.spawn });
    k.start();
    const p = k.query({});
    const state = track(p);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).rejects.toMatchObject({ kind: 'timeout' });
    await k.stop();
  });

  it('таймаут освобождает место в очереди для следующего запроса', async () => {
    const f = fakeSpawner(() => undefined);
    const k = new KataGo({ ...opts, spawn: f.spawn, maxConcurrent: 1 });
    k.start();
    const a = k.query({ n: 1 }, 20);
    const b = k.query({ n: 2 }, 1000);
    track(a);
    track(b);
    await tick();
    const s = at(f.spawned, 0);
    expect(s.written).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20);
    await expect(a).rejects.toMatchObject({ kind: 'timeout' });
    await tick();
    // terminate + сам запрос q2
    expect(s.written).toHaveLength(3);
    expect(JSON.parse(at(s.written, 2))).toEqual({ id: 'q2', n: 2 });
    expect(k.queueLength).toBe(1);
    await k.stop();
  });

  it('поздний ответ на отклонённый по таймауту запрос игнорируется', async () => {
    const replies: Reply[] = [];
    const f = fakeSpawner((q, reply) => {
      if (q.action !== 'terminate') replies.push(() => reply({ id: q.id, late: true }));
    });
    const k = new KataGo({ ...opts, spawn: f.spawn });
    k.start();
    const a = k.query({}, 20);
    track(a);
    await tick();
    await vi.advanceTimersByTimeAsync(20);
    await expect(a).rejects.toMatchObject({ kind: 'timeout' });
    at(replies, 0)(undefined);
    await tick();
    expect(k.queueLength).toBe(0);
    // обёртка жива и обслуживает следующий запрос
    const b = k.query({});
    await tick();
    at(replies, 1)(undefined);
    expect(await b).toMatchObject({ id: 'q2', late: true });
    await k.stop();
  });

  it('падение процесса: запрос в полёте отклоняется, ждущий в очереди переживает перезапуск', async () => {
    const f = fakeSpawner((q, reply, i) => {
      if (i > 0) reply({ id: q.id, ok: true });
    });
    const k = new KataGo({ ...opts, spawn: f.spawn, maxConcurrent: 1 });
    k.start();
    const a = k.query({ n: 1 });
    const b = k.query({ n: 2 });
    track(a);
    track(b);
    await tick();
    expect(k.queueLength).toBe(2);
    at(f.spawned, 0).exit(137);
    await expect(a).rejects.toMatchObject({ kind: 'crashed' });
    expect(k.alive).toBe(false);
    expect(k.queueLength).toBe(1);
    expect(f.spawned).toHaveLength(1);
    // пауза перезапуска и дедлайн ждущего запроса: его таймаут идёт от вызова
    expect(vi.getTimerCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(10);
    expect(f.spawned).toHaveLength(2);
    expect(k.restarts).toBe(1);
    expect(k.alive).toBe(true);
    expect(await b).toMatchObject({ id: 'q2', ok: true });
    await k.stop();
    expect(k.alive).toBe(false);
  });

  it('код выхода попадает в текст ошибки и в лог', async () => {
    const logs: string[] = [];
    const f = fakeSpawner(() => undefined);
    const k = new KataGo({ ...opts, spawn: f.spawn, log: (l) => logs.push(l) });
    k.start();
    const a = k.query({});
    track(a);
    await tick();
    at(f.spawned, 0).exit(137);
    await expect(a).rejects.toThrow(/exited with code 137/);
    expect(logs.some((l) => l.includes('restart #1'))).toBe(true);
    await k.stop();
  });

  it('пауза перезапуска идёт по шагам списка и упирается в последний', async () => {
    const f = fakeSpawner(() => undefined);
    const k = new KataGo({ ...opts, spawn: f.spawn, backoffMs: [10, 20, 30] });
    k.start();
    const steps = [10, 20, 30, 30];
    for (let i = 0; i < steps.length; i++) {
      at(f.spawned, i).exit(1);
      await vi.advanceTimersByTimeAsync(at(steps, i) - 1);
      expect(f.spawned).toHaveLength(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.spawned).toHaveLength(i + 2);
    }
    expect(k.restarts).toBe(4);
    await k.stop();
  });

  it('повторный exit старого процесса не считается новым падением', async () => {
    const f = fakeSpawner(() => undefined);
    const k = new KataGo({ ...opts, spawn: f.spawn, backoffMs: [10] });
    k.start();
    at(f.spawned, 0).exit(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(f.spawned).toHaveLength(2);
    expect(k.restarts).toBe(1);
    // тот же, уже отцепленный процесс повторяет exit: это не падение живого движка
    at(f.spawned, 0).exit(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.spawned).toHaveLength(2);
    expect(k.restarts).toBe(1);
    expect(k.alive).toBe(true);
    await k.stop();
  });

  it('успешный ответ сбрасывает шаг паузы на первый', async () => {
    const f = fakeSpawner((q, reply) => reply({ id: q.id }));
    const k = new KataGo({ ...opts, spawn: f.spawn, backoffMs: [10, 1000] });
    k.start();
    at(f.spawned, 0).exit(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(f.spawned).toHaveLength(2);
    await k.query({});
    at(f.spawned, 1).exit(1);
    await vi.advanceTimersByTimeAsync(9);
    expect(f.spawned).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.spawned).toHaveLength(3);
    await k.stop();
  });

  it('stop отклоняет и запросы в полёте, и ждущие в очереди', async () => {
    const f = fakeSpawner(() => undefined);
    const k = new KataGo({ ...opts, spawn: f.spawn, maxConcurrent: 1 });
    k.start();
    const a = k.query({ n: 1 });
    const b = k.query({ n: 2 });
    track(a);
    track(b);
    await tick();
    expect(k.queueLength).toBe(2);
    const stopping = k.stop();
    await expect(a).rejects.toMatchObject({ kind: 'crashed' });
    await expect(b).rejects.toMatchObject({ kind: 'crashed' });
    await stopping;
    expect(k.queueLength).toBe(0);
    expect(k.alive).toBe(false);
    expect(at(f.spawned, 0).kills).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.spawned).toHaveLength(1);
    expect(k.restarts).toBe(0);
  });

  it('stop во время паузы перезапуска отменяет перезапуск и чистит очередь', async () => {
    const f = fakeSpawner(() => undefined);
    const k = new KataGo({ ...opts, spawn: f.spawn, backoffMs: [50] });
    k.start();
    const a = k.query({});
    track(a);
    await tick();
    at(f.spawned, 0).exit(1);
    await expect(a).rejects.toMatchObject({ kind: 'crashed' });
    const b = k.query({});
    track(b);
    await k.stop();
    await expect(b).rejects.toMatchObject({ kind: 'crashed' });
    expect(k.queueLength).toBe(0);
    expect(vi.getTimerCount()).toBe(0); // пауза перезапуска снята, а не просто забыта
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.spawned).toHaveLength(1);
  });

  it('запрос после stop отклоняется сразу, а не копится в очереди', async () => {
    const f = fakeSpawner(() => undefined);
    const k = new KataGo({ ...opts, spawn: f.spawn });
    k.start();
    await k.stop();
    await expect(k.query({})).rejects.toMatchObject({ kind: 'crashed' });
    expect(k.queueLength).toBe(0);
  });

  it('повторный start не плодит процессов, start после stop ничего не делает', async () => {
    const f = fakeSpawner(() => undefined);
    const k = new KataGo({ ...opts, spawn: f.spawn });
    k.start();
    k.start();
    expect(f.spawned).toHaveLength(1);
    await k.stop();
    k.start();
    expect(f.spawned).toHaveLength(1);
    expect(k.alive).toBe(false);
  });

  it('ответ, разорванный на два куска, собирается в одну строку', async () => {
    const f = fakeSpawner(() => undefined);
    const k = new KataGo({ ...opts, spawn: f.spawn });
    k.start();
    const p = k.query({});
    await tick();
    const out = at(f.spawned, 0).stdout;
    out.write('{"id":"q1","half":');
    await tick();
    out.write('true}\n');
    expect(await p).toMatchObject({ id: 'q1', half: true });
    await k.stop();
  });

  it('два ответа в одной записи разбираются по строкам', async () => {
    const f = fakeSpawner(() => undefined);
    const k = new KataGo({ ...opts, spawn: f.spawn, maxConcurrent: 2 });
    k.start();
    const a = k.query({});
    const b = k.query({});
    await tick();
    at(f.spawned, 0).stdout.write('{"id":"q1","n":1}\n{"id":"q2","n":2}\n');
    expect(await a).toMatchObject({ n: 1 });
    expect(await b).toMatchObject({ n: 2 });
    await k.stop();
  });

  it('мусор вместо JSON не роняет обёртку и уходит в лог', async () => {
    const logs: string[] = [];
    const f = fakeSpawner(() => undefined);
    const k = new KataGo({ ...opts, spawn: f.spawn, log: (l) => logs.push(l) });
    k.start();
    const p = k.query({});
    track(p);
    await tick();
    const out = at(f.spawned, 0).stdout;
    out.write('katago: loading model\n');
    await tick();
    expect(logs.some((l) => l.includes('non-json'))).toBe(true);
    expect(k.queueLength).toBe(1);
    out.write('{"id":"q1","ok":true}\n');
    expect(await p).toMatchObject({ ok: true });
    await k.stop();
  });

  it('строка без id, эхо terminate и isDuringSearch не завершают запрос', async () => {
    const logs: string[] = [];
    const f = fakeSpawner(() => undefined);
    const k = new KataGo({ ...opts, spawn: f.spawn, log: (l) => logs.push(l) });
    k.start();
    const p = k.query({});
    const state = track(p);
    await tick();
    const out = at(f.spawned, 0).stdout;
    out.write('{"error":"global failure"}\n');
    out.write('{"id":"q1","action":"terminate"}\n');
    out.write('{"id":"q1","isDuringSearch":true,"rootInfo":{}}\n');
    await tick();
    expect(state.settled).toBe(false);
    expect(k.queueLength).toBe(1);
    expect(logs.some((l) => l.includes('global failure'))).toBe(true);
    out.write('{"id":"q1","done":true}\n');
    expect(await p).toMatchObject({ done: true });
    await k.stop();
  });

  it('warning логируется и не завершает запрос', async () => {
    const logs: string[] = [];
    const f = fakeSpawner(() => undefined);
    const k = new KataGo({ ...opts, spawn: f.spawn, log: (l) => logs.push(l) });
    k.start();
    const p = k.query({});
    const state = track(p);
    await tick();
    const out = at(f.spawned, 0).stdout;
    out.write('{"id":"q1","warning":"meh","field":"rules"}\n');
    await tick();
    expect(state.settled).toBe(false);
    expect(logs.some((l) => l.includes('meh') && l.includes('rules'))).toBe(true);
    out.write('{"id":"q1","ok":true}\n');
    expect(await p).toMatchObject({ ok: true });
    await k.stop();
  });

  it('error вместе с warning всё равно отклоняет запрос', async () => {
    const f = fakeSpawner(() => undefined);
    const k = new KataGo({ ...opts, spawn: f.spawn });
    k.start();
    const p = k.query({});
    track(p);
    await tick();
    at(f.spawned, 0).stdout.write('{"id":"q1","warning":"meh","error":"boom","field":"moves"}\n');
    await expect(p).rejects.toThrow(/boom.*moves/);
    await k.stop();
  });

  it('stderr процесса уходит в log', async () => {
    const logs: string[] = [];
    const f = fakeSpawner(() => undefined);
    const k = new KataGo({ ...opts, spawn: f.spawn, log: (l) => logs.push(l) });
    k.start();
    at(f.spawned, 0).stderr.write('GPU not found\n');
    await tick();
    expect(logs.some((l) => l.includes('GPU not found'))).toBe(true);
    await k.stop();
  });

  it('запрос до start отклоняется сразу, а не виснет навсегда', async () => {
    const f = fakeSpawner(() => undefined);
    const k = new KataGo({ ...opts, spawn: f.spawn });
    await expect(k.query({})).rejects.toMatchObject({ kind: 'crashed' });
    await expect(k.query({})).rejects.toThrow(/not started/);
    expect(k.queueLength).toBe(0);
    expect(f.spawned).toHaveLength(0);
  });

  it('запрос во время паузы перезапуска не отклоняется, а ждёт нового процесса', async () => {
    const f = fakeSpawner((q, reply, i) => {
      if (i > 0) reply({ id: q.id, ok: true });
    });
    const k = new KataGo({ ...opts, spawn: f.spawn, backoffMs: [10] });
    k.start();
    at(f.spawned, 0).exit(1);
    expect(k.alive).toBe(false);
    const p = k.query({});
    expect(k.queueLength).toBe(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(await p).toMatchObject({ ok: true });
    await k.stop();
  });

  it('дедлайн отсчитывается от вызова: третий в очереди отваливается на своём timeoutMs', async () => {
    const f = fakeSpawner(() => undefined); // движок молчит: все три доживут до таймаута
    const k = new KataGo({ ...opts, spawn: f.spawn, maxConcurrent: 1 });
    k.start();
    const a = k.query({ n: 1 }, 1000);
    const b = k.query({ n: 2 }, 1000);
    const c = k.query({ n: 3 }, 1000);
    const sa = track(a);
    const sb = track(b);
    const sc = track(c);
    await tick();
    const s = at(f.spawned, 0);
    expect(s.written).toHaveLength(1); // движку ушёл только первый
    await vi.advanceTimersByTimeAsync(999);
    expect([sa.settled, sb.settled, sc.settled]).toEqual([false, false, false]);
    await vi.advanceTimersByTimeAsync(1);
    await expect(a).rejects.toMatchObject({ kind: 'timeout' });
    await expect(b).rejects.toMatchObject({ kind: 'timeout' });
    await expect(c).rejects.toMatchObject({ kind: 'timeout' });
    await tick();
    // движок увидел первый запрос и terminate к нему; второй и третий ему не отправлялись
    const sent = s.written.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(sent.filter((m) => m.n !== undefined)).toHaveLength(1);
    expect(k.queueLength).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await k.stop();
  });

  it('ждущий запрос с коротким дедлайном отклоняется в очереди и движку не уходит', async () => {
    const f = fakeSpawner(() => undefined);
    const k = new KataGo({ ...opts, spawn: f.spawn, maxConcurrent: 1 });
    k.start();
    const a = k.query({ n: 1 }, 1000);
    const b = k.query({ n: 2 }, 400);
    track(a);
    track(b);
    await tick();
    const s = at(f.spawned, 0);
    await vi.advanceTimersByTimeAsync(400);
    await expect(b).rejects.toMatchObject({ kind: 'timeout' });
    await tick();
    // terminate ждущему не шлётся: движок его не видел
    expect(s.written).toHaveLength(1);
    expect(k.queueLength).toBe(1);
    await vi.advanceTimersByTimeAsync(600);
    await expect(a).rejects.toMatchObject({ kind: 'timeout' });
    await tick();
    // после освобождения места отправлять уже нечего
    const sent = s.written.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(sent.some((m) => m.n === 2)).toBe(false);
    await k.stop();
  });

  it('сообщение с нестроковым id считается глобальным и уходит в лог', async () => {
    const logs: string[] = [];
    const f = fakeSpawner(() => undefined);
    const k = new KataGo({ ...opts, spawn: f.spawn, log: (l) => logs.push(l) });
    k.start();
    const p = k.query({});
    const state = track(p);
    await tick();
    const out = at(f.spawned, 0).stdout;
    out.write('{"id":123,"error":"numeric id failure"}\n');
    await tick();
    expect(logs.some((l) => l.includes('numeric id failure'))).toBe(true);
    expect(state.settled).toBe(false);
    expect(k.queueLength).toBe(1);
    out.write('{"id":"q1","ok":true}\n');
    expect(await p).toMatchObject({ ok: true });
    await k.stop();
  });

  it('недоступный bin не роняет go-engine: запрос отклоняется, причина в логе', async () => {
    const logs: string[] = [];
    // Настоящий spawn, без подделки: этот путь иначе не покрыт ничем.
    const k = new KataGo({
      bin: 'goko-no-such-binary-xyz',
      model: 'main',
      humanModel: 'human',
      config: 'cfg',
      backoffMs: [10],
      log: (l) => logs.push(l),
    });
    k.start();
    const p = k.query({ n: 1 }, 5000);
    await expect(p).rejects.toMatchObject({ kind: 'crashed' });
    await tick();
    expect(k.alive).toBe(false);
    expect(k.restarts).toBe(1); // падение учтено, перезапуск запланирован
    expect(logs.some((l) => l.includes('spawn failed') && l.includes('ENOENT'))).toBe(true);
    await k.stop();
  });

  it('счётчики на старте нулевые', () => {
    const f = fakeSpawner(() => undefined);
    const k = new KataGo({ ...opts, spawn: f.spawn });
    expect(k.alive).toBe(false);
    expect(k.queueLength).toBe(0);
    expect(k.restarts).toBe(0);
    k.start();
    expect(k.alive).toBe(true);
  });
});
