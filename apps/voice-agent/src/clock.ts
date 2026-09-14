// Часы как шов для тестов без реального времени: after ставит таймер и возвращает его отмену.
export type Clock = { after(ms: number, fn: () => void): () => void };

export const realClock: Clock = {
  after(ms, fn) {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};
