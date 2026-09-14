import { ConnectionError, ConnectionErrorReason } from 'livekit-client';

// Только отказ авторизации означает, что повтор с тем же токеном бесполезен.
export const connectionFailureAction = (e: unknown): 'reset' | 'retry' =>
  e instanceof ConnectionError && e.reason === ConnectionErrorReason.NotAllowed ? 'reset' : 'retry';
