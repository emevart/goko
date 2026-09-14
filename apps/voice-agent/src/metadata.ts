// sessionId из метаданных диспетчеризации (game-server кладёт { sessionId } в agents комнаты при createRoom, D-0001);
// запасной путь — имя комнаты goko-<sessionId>.
export function sessionIdOf(metadata: string | undefined, roomName: string): string {
  if (metadata) {
    try {
      const parsed: unknown = JSON.parse(metadata);
      if (parsed && typeof parsed === 'object' && 'sessionId' in parsed && typeof parsed.sessionId === 'string') {
        return parsed.sessionId;
      }
    } catch {
      // не JSON — берём имя комнаты
    }
  }
  return roomName.replace(/^goko-/, '');
}
