// Загрузка воркера для LiveKit (D-0013): по числу идущих job, а не по CPU машины.
// По умолчанию @livekit/agents 1.8 шлёт серверу загрузку CPU (вне контейнера — всей машины). Сервер LiveKit
// выбирает воркер для новой комнаты только при загрузке ниже SERVER_TARGET_LOAD, а отказ не повторяет: комната,
// созданная в момент всплеска CPU (vite, KataGo, старт процесса job), навсегда оставалась без агента.
// Число job от чужой нагрузки не зависит, и отказ случается только при настоящем избытке сеансов.

// targetLoad сервера LiveKit по умолчанию (livekit-server 1.13, pkg/agent/config.go). Не настройка воркера —
// граница, по которой считается потолок ниже.
export const SERVER_TARGET_LOAD = 0.7;

// Сервер даёт job, пока activeJobs / MAX_JOBS < 0,7, поэтому одновременно идёт не больше jobCeiling() = 6 job.
// Почему 8:
// - MAX_SESSIONS game-server по умолчанию 3, одна сессия — одна комната и одна job. Сверх них живут job брошенных
//   комнат: без телефона комната ждёт до 5 мин (emptyTimeout), после ухода телефона — до 15 мин (departure.ts).
//   Потолок 6 — запас вдвое, отказ при обычной работе не наступает.
// - Потолок не бесконечный: цикл, плодящий комнаты, упрётся в 6 процессов job, а не съест 4 ГБ VPS.
// - 0,7 * 8 = 5,6 — не целое: ни одно число job не даёт ровно 0,7, граница не зависит от округления float.
// Поднимая MAX_SESSIONS выше 6, поднять и MAX_JOBS.
export const MAX_JOBS = 8;

// Порог FULL у самого воркера сравнивается со значением loadFunc: FULL — при activeJobs = MAX_JOBS.
// Раньше этого сервер перестаёт давать job сам (на 0,7).
export const LOAD_THRESHOLD = 1;

// Тёплые процессы job. Без них (умолчание @livekit/agents 1.8 в dev — 0) ProcPool.launchJob кладёт исполнитель
// в executors и не удаляет, а runningJob исполнителя после выхода процесса не сбрасывается (ipc/proc_pool.ts,
// ipc/job_proc_executor.ts). activeJobs — исполнители с runningJob (worker.ts), поэтому в dev каждая завершённая
// job оставалась в счёте: после шестой комнаты за жизнь воркера сервер молча переставал давать ему job.
// Исполнитель из пула удаляет только procWatchTask тёплого процесса, а он работает при numIdleProcesses > 0.
// Один тёплый процесс: в dev заодно быстрее вход агента; в start вместо min(CPU, 4) = 2 на cx23 — 1, память VPS
// экономится, вторая одновременная комната стартует чуть дольше (процесс создаётся на ходу).
// Явное значение нужно и потому, что cli.runApp пересобирает опции: 0 там заменился бы умолчанием режима.
export const NUM_IDLE_PROCESSES = 1;

export function jobLoad(activeJobs: number, maxJobs: number = MAX_JOBS): number {
  return Math.min(activeJobs / maxJobs, 1);
}

// Опции ServerOptions про загрузку и пул процессов; main.ts раскладывает их в ServerOptions, тест проверяет.
export function workerPoolOptions(): {
  loadFunc: (server: { activeJobs: readonly unknown[] }) => Promise<number>;
  loadThreshold: number;
  numIdleProcesses: number;
} {
  return {
    loadFunc: async (server) => jobLoad(server.activeJobs.length),
    loadThreshold: LOAD_THRESHOLD,
    numIdleProcesses: NUM_IDLE_PROCESSES,
  };
}

// Сколько job идёт одновременно, когда сервер перестаёт давать новые: первое n с загрузкой не ниже 0,7.
export function jobCeiling(maxJobs: number = MAX_JOBS): number {
  let n = 0;
  while (jobLoad(n, maxJobs) < SERVER_TARGET_LOAD) n++;
  return n;
}
