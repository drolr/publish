import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clearCrashState } from '../../src/infrastructure/automation/browser-session';

const roots: string[] = [];
const profile = async (preferences: string): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'draft-crash-state-'));
  roots.push(root);
  await mkdir(join(root, 'Default'), { recursive: true });
  await writeFile(join(root, 'Default', 'Preferences'), preferences);
  return root;
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('clearCrashState', () => {
  it('rewrites a crashed exit state as a normal one', async () => {
    const root = await profile(
      JSON.stringify({
        profile: { exit_type: 'Crashed', exited_safely: false },
        other: 1,
      }),
    );
    await clearCrashState(root);
    expect(
      JSON.parse(await readFile(join(root, 'Default', 'Preferences'), 'utf8')),
    ).toEqual({
      profile: { exit_type: 'Normal', exited_safely: true },
      other: 1,
    });
  });

  it('leaves an already normal profile untouched', async () => {
    const original = JSON.stringify({
      profile: { exit_type: 'Normal', exited_safely: true },
    });
    const root = await profile(original);
    await clearCrashState(root);
    expect(await readFile(join(root, 'Default', 'Preferences'), 'utf8')).toBe(
      original,
    );
  });

  it('ignores a missing profile without throwing', async () => {
    await expect(
      clearCrashState(join(tmpdir(), 'draft-crash-state-missing')),
    ).resolves.toBeUndefined();
  });
});
