import { describe, expect, it } from 'vitest';
import { ConnectionError, ConnectionErrorReason } from 'livekit-client';
import { connectionFailureAction } from './session-connection.ts';

describe('connectionFailureAction', () => {
  it('после отказа LiveKit требует новую сессию, а не повтор с мёртвым токеном', () => {
    const rejected = Object.assign(Object.create(ConnectionError.prototype), {
      reason: ConnectionErrorReason.NotAllowed,
    });
    expect(connectionFailureAction(rejected)).toBe('reset');
  });

  it('после временного сбоя сохраняет сессию для повтора входа', () => {
    expect(connectionFailureAction(new Error('network unavailable'))).toBe('retry');
  });
});
