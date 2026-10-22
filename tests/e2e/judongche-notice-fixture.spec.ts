import { test, expect } from '@playwright/test';
import { installProductionFixture } from '../fixtures/judongche-production';
import { denyExternalNetwork } from './network-policy';
import { createJudongcheAdapter } from '../../src/infrastructure/platforms/judongche/draft-adapter';

const heading = '您有门店实车信息配置缺失，会影响现车等im线索，需尽快配置';
const message =
  '懂车帝实车信息管理页面由于关联ai小懂，并展示于门店车系页/im页面，现需维护门店现车、展车、试驾车信息，14天未更新自动标黄，30天未更新暂停Al使用，未维护页面点无需更新即可，或一键配置即可配置完毕进行展示。';
for (const variant of [
  'known',
  'changed',
  'security',
  'extra-dialog',
  'close-noop',
] as const) {
  test(`entry closes only the observed informational notice: ${variant}`, async ({
    context,
    page,
  }) => {
    await denyExternalNetwork(context);
    await installProductionFixture(context);
    await page.goto('https://www.autoengine.com/jdc/dealer/info/Article');
    await page.evaluate(
      ({ heading, message, variant }) => {
        const dialog = document.createElement('div');
        dialog.setAttribute('role', 'dialog');
        dialog.innerHTML =
          '<h2>通知公告</h2><p></p><p></p><button>关闭</button><button>去看看</button>';
        dialog.querySelectorAll('p')[0]!.textContent = heading;
        dialog.querySelectorAll('p')[1]!.textContent =
          variant === 'changed' ? '另一种未知公告' : message;
        dialog.querySelector('button')!.onclick = () => {
          document.body.dataset.noticeClose = String(
            Number(document.body.dataset.noticeClose ?? 0) + 1,
          );
          if (variant !== 'close-noop') dialog.remove();
        };
        document.body.append(dialog);
        if (variant === 'security') {
          const safety = document.createElement('p');
          safety.textContent = '安全验证';
          document.body.append(safety);
        }
        if (variant === 'extra-dialog') {
          const extra = document.createElement('div');
          extra.setAttribute('role', 'dialog');
          extra.textContent = '未知窗口';
          document.body.append(extra);
        }
      },
      { heading, message, variant },
    );
    const adapter = createJudongcheAdapter(
      {
        open: async () => context,
        current: () => context,
        generation: () => 'notice-fixture',
        close: async () => {},
      },
      undefined,
      {
        manualReview: true,
        ownerConfirmedPilot: { dealerId: '123456', storeName: '合成门店' },
      },
    );
    const result = await adapter.checkSession();
    expect(result.status).toBe(variant === 'known' ? 'ready' : 'blocked');
    expect(await page.locator('body').getAttribute('data-notice-close')).toBe(
      variant === 'known' || variant === 'close-noop' ? '1' : null,
    );
    expect(await page.locator('textarea').inputValue()).toBe('');
  });
}
