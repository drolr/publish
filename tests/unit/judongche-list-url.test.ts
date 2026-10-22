import { describe, expect, it } from 'vitest';
import { knownUrl } from '../../src/infrastructure/platforms/judongche/production-state';

const list =
  'https://www.autoengine.com/jdc/dealer/info/contentPublish/content/index-cps2';
describe('observed CPS2 article list URL', () => {
  it('accepts the observed article tab without relaxing other routes', () => {
    expect(knownUrl(list + '?pageTab=0')).toBe(true);
    for (const url of [
      list + '?pageTab=1',
      list + '?pageTab=0&pageTab=0',
      list + '?pageTab=0&redirect=elsewhere',
      list + '?pageTab=0#unknown',
      list.replace('https:', 'http:') + '?pageTab=0',
      list.replace('www.autoengine.com', 'example.com') + '?pageTab=0',
      'https://www.autoengine.com/jdc/cps/home?pageTab=0',
    ])
      expect(knownUrl(url), url).toBe(false);
  });
});
