import { expect, it } from 'vitest';
import { createLibraryWriteGate } from '../../src/desktop/main/library-write-gate';
it.each(['session', 'active', 'blocked', 'unknown'] as const)(
  'manual_delete_draft_mutual_exclusion during cover %s',
  (state) => {
    const gate = createLibraryWriteGate({
      available: () => true,
      isClosing: () => false,
      cover: {
        hasSession: () => state === 'session',
        isActive: () => state === 'active',
        isBlocked: () => {
          if (state === 'unknown') throw Error('unknown');
          return state === 'blocked';
        },
      },
    });
    expect(gate.state()).toBe(
      ['session', 'active'].includes(state) ? 'busy' : 'unavailable',
    );
    expect(gate.startImport()).toEqual({ status: 'unavailable' });
  },
);
