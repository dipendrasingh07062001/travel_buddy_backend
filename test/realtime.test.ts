import { describe, expect, it } from 'vitest';

import { parseRealtimeEvent } from '../src/realtime/realtime-events.js';

describe('realtime event payloads', () => {
  it('accepts the events the API publishes', () => {
    expect(
      parseRealtimeEvent(
        JSON.stringify({
          type: 'message.created',
          messageId: 'm-1',
          tripId: 't-1',
        }),
      ),
    ).toEqual({ type: 'message.created', messageId: 'm-1', tripId: 't-1' });
    expect(
      parseRealtimeEvent(
        JSON.stringify({ type: 'notifications.changed', userIds: ['u-1'] }),
      ),
    ).toEqual({ type: 'notifications.changed', userIds: ['u-1'] });
  });

  it('ignores malformed or unknown payloads', () => {
    for (const payload of [
      'not json',
      'null',
      JSON.stringify({ type: 'message.created', messageId: 'm-1' }),
      JSON.stringify({ type: 'notifications.changed', userIds: [1] }),
      JSON.stringify({ type: 'trip.deleted', tripId: 't-1' }),
    ]) {
      expect(parseRealtimeEvent(payload)).toBeNull();
    }
  });
});
