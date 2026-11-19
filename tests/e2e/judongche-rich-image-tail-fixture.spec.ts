import { test, expect } from '@playwright/test';
import type { PersistedEditorBodyV2 } from '../../src/contracts/rich-text-body';
import { createAdapterWithPages } from '../../src/infrastructure/platforms/judongche/draft-adapter';
import { createJudongchePages } from '../../src/infrastructure/platforms/judongche/page-contract';
import { richCapabilities, richDraftHarness } from '../fixtures/rich-draft';
import { installProductionFixture } from '../fixtures/judongche-production';
import { denyExternalNetwork } from './network-policy';
import type { RichEditorEvidence } from '../../src/infrastructure/platforms/judongche/rich-content-evidence';
import type { ProbeDiagnostic } from '../../src/infrastructure/platforms/judongche/production-pages';

const paragraph = (text: string) => ({
  type: 'paragraph' as const,
  content: text ? [{ type: 'text' as const, text, marks: [] }] : [],
});

for (const scenario of [
  'plain',
  'blank',
  'operator',
  'formatted',
  'five',
  'five-alternating',
  'structured',
  'ending',
  'multiline',
  'image-no-tail',
  'image-normalization',
  'format-drift',
  'prefix-drift',
  'unknown',
] as const) {
  test(`production rich writer preserves text/image boundaries: ${scenario}`, async ({
    context,
    page,
  }) => {
    await denyExternalNetwork(context);
    const operatorSubmission = [
      'operator',
      'five',
      'five-alternating',
      'structured',
      'blank',
    ].includes(scenario);
    const fixture = await installProductionFixture(context, {
      observedTrailingParagraphs: true,
      bodyInputLifecycle:
        scenario === 'five-alternating' ? 'alternating' : 'rebuild',
    });
    await page.goto(fixture.home);
    const body: PersistedEditorBodyV2 = {
      version: 2,
      blocks: [
        paragraph('前文'.repeat(129) + '末'),
        ...(scenario === 'blank' ? [paragraph('')] : []),
        { type: 'image', imageId: 'X' },
        paragraph(
          scenario === 'multiline' ? '图片后续正文\n下一行' : '图片后续正文',
        ),
        { type: 'image', imageId: 'X' },
        { type: 'image', imageId: 'X' },
        ...(['five', 'five-alternating'].includes(scenario)
          ? [
              { type: 'image' as const, imageId: 'X' },
              { type: 'image' as const, imageId: 'X' },
            ]
          : []),
        ...(scenario === 'ending' ? [] : [paragraph('尾段')]),
      ],
    };
    if (scenario === 'formatted' && body.blocks[2].type === 'paragraph')
      body.blocks[2].content[0].marks = ['bold'];
    if (scenario === 'structured') {
      body.blocks.splice(
        4,
        0,
        {
          type: 'heading',
          content: [{ type: 'text', text: '图片后小标题', marks: [] }],
        },
        { type: 'list', kind: 'bullet', items: [paragraph('图片后列表')] },
      );
      if (body.blocks[2].type === 'paragraph')
        body.blocks[2].content[0].marks = ['bold'];
    }
    const h = richDraftHarness(body);
    const session = {
      open: async () => context,
      current: () => context,
      generation: () => 'fixture-generation',
      close: async () => {},
    };
    const events: ProbeDiagnostic[] = [];
    const pages = createJudongchePages(session, (event) => events.push(event), {
      manualReview: true,
      ...(operatorSubmission
        ? { batchSubmissionReview: 'operator' as const }
        : {}),
      ownerConfirmedPilot: { dealerId: '123456', storeName: '合成门店' },
    });
    const enter = pages.enterNewEditor;
    pages.enterNewEditor = async (...args) => {
      await enter(...args);
      // Reuse the observed production-tail/image fixture with the narrow DOM
      // surface needed by the real rich writer. No editor writes are mocked.
      await page.evaluate((scenario) => {
        const editor = document.querySelector<HTMLElement>('#body')!;
        const wrapper = document.createElement('div');
        wrapper.className = 'publish-editor';
        editor.before(wrapper);
        wrapper.append(editor);
        editor.classList.add('ProseMirror');
        if (scenario === 'image-no-tail' || scenario === 'image-normalization')
          document.addEventListener(
            'click',
            (event) => {
              const button = event.target as Element;
              if (
                button.tagName !== 'BUTTON' ||
                button.textContent !== '确定' ||
                !button.closest('[role=dialog]')
              )
                return;
              queueMicrotask(() => {
                if (
                  scenario === 'image-no-tail' &&
                  editor.lastElementChild?.tagName === 'P'
                )
                  editor.lastElementChild.remove();
                if (
                  scenario === 'image-normalization' &&
                  !editor.dataset.normalized
                ) {
                  editor.dataset.normalized = 'true';
                  const padding = document.createElement('p');
                  padding.innerHTML = '<br class="ProseMirror-trailingBreak">';
                  editor.prepend(padding);
                }
              });
            },
            true,
          );
        // This contenteditable fixture has no ProseMirror selection plugin.
        // Model its normal empty-paragraph click behavior at image boundaries.
        editor.addEventListener('mousedown', (event) => {
          const target = (event.target as Element).closest('p');
          if (target?.parentElement !== editor) return;
          const content = target.cloneNode(true) as Element;
          content
            .querySelectorAll('.syl-placeholder, img.ProseMirror-separator')
            .forEach((node) => node.remove());
          if (content.textContent) return;
          if (
            scenario === 'prefix-drift' &&
            editor.querySelector('.pgc-image') &&
            editor.textContent?.includes('图片后续正文') &&
            !editor.dataset.drifted
          ) {
            editor.dataset.drifted = 'true';
            editor.querySelector('p')!.textContent = '前文被修改';
          }
          event.preventDefault();
          editor.focus();
          const range = document.createRange();
          range.selectNodeContents(target);
          range.collapse(true);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
        });
        for (const name of [
          'bold',
          'italic',
          'underline',
          'header',
          'bullet_list',
        ]) {
          const tool = document.createElement('div');
          tool.className = 'syl-toolbar-tool ' + name;
          const button = document.createElement('button');
          button.className = 'syl-toolbar-button';
          button.textContent = name;
          button.onmousedown = (event) => event.preventDefault();
          button.onclick = () => {
            const active = !tool.classList.contains('active');
            editor.focus();
            if (name === 'header')
              document.execCommand('formatBlock', false, 'h2');
            else if (name === 'bullet_list') {
              const anchor = window.getSelection()?.anchorNode;
              const paragraph = (
                anchor instanceof Element ? anchor : anchor?.parentElement
              )?.closest('p');
              if (paragraph?.parentElement === editor) {
                const list = document.createElement('ul');
                const item = document.createElement('li');
                paragraph.replaceWith(list);
                list.append(item);
                // B08-final.html / q3b-b02-ul-2items.html use inline LI leaves.
                item.append(...Array.from(paragraph.childNodes));
                const range = document.createRange();
                range.selectNodeContents(item);
                range.collapse(true);
                window.getSelection()?.removeAllRanges();
                window.getSelection()?.addRange(range);
              }
            } else if (document.queryCommandState(name) !== active)
              document.execCommand(name);
            tool.classList.toggle('active', active);
          };
          tool.append(button);
          document.querySelector('.syl-toolbar')!.append(tool);
        }
      }, scenario);
    };
    const adapter = createAdapterWithPages(session, pages, richCapabilities);
    const probe = await adapter.checkSession();
    if (probe.status !== 'ready') throw Error('fixture not ready');
    h.task.store = probe.store;
    h.durable().store = probe.store;
    let beforeHome: RichEditorEvidence | undefined;
    let beforeHomeChildren: number | undefined;
    let caretBeforeSave: unknown;
    let inputActions: { mode: string; selected: number; confirmed: number }[] =
      [];
    const captureBeforeSave = async () => {
      const observed = await page.locator('#body').evaluate((editor) => {
        const selection = window.getSelection();
        return {
          active: document.activeElement === editor,
          collapsed: selection?.isCollapsed,
          inTail:
            !!selection?.anchorNode &&
            editor.lastElementChild?.contains(selection.anchorNode),
          offset: selection?.anchorOffset,
          atFinalImageBoundary:
            selection?.anchorNode === editor &&
            editor.childNodes[selection.anchorOffset] ===
              editor.querySelector('div[__syl_tag]:nth-last-child(2)'),
          inputActions: (
            window as unknown as {
              bodyInputActions: {
                mode: string;
                selected: number;
                confirmed: number;
              }[];
            }
          ).bodyInputActions,
        };
      });
      inputActions = observed.inputActions;
      caretBeforeSave = {
        active: observed.active,
        collapsed: observed.collapsed,
        inTail: observed.inTail,
        offset: observed.offset,
        atFinalImageBoundary: observed.atFinalImageBoundary,
      };
    };
    const saveWithCaret = pages.saveOnce;
    pages.saveOnce = async (...args) => {
      await captureBeforeSave();
      await saveWithCaret(...args);
    };
    const operatorSaveWithCaret = pages.saveForOperatorReview!;
    pages.saveForOperatorReview = async (...args) => {
      await captureBeforeSave();
      return operatorSaveWithCaret(...args);
    };
    if (operatorSubmission) {
      h.hooks.batchSubmissionReview = 'operator';
      const returnHome = pages.returnHomeAfterSubmission!;
      pages.returnHomeAfterSubmission = async (...args) => {
        beforeHome = await pages.inspectRichEditor!();
        beforeHomeChildren = await page.locator('#body > *').count();
        await returnHome(...args);
      };
    }
    if (scenario === 'format-drift' || scenario === 'unknown') {
      const save = pages.saveOnce;
      pages.saveOnce = async () => {
        await page
          .locator('#body > p')
          .first()
          .evaluate((node, fault) => {
            const replacement = document.createElement(
              fault === 'unknown' ? 'section' : 'strong',
            );
            replacement.textContent = node.textContent;
            if (fault === 'unknown') node.replaceWith(replacement);
            else node.replaceChildren(replacement);
          }, scenario);
        await save();
      };
      expect(await adapter.execute(h.task, h.hooks)).toEqual({
        status: 'blocked',
        reason: 'MANUAL_REVIEW_REQUIRED',
      });
      expect(fixture.saves()).toBe(1);
      expect(h.durable().evidence.images).toHaveLength(3);
      return;
    }
    const result = await adapter.execute(h.task, h.hooks);
    if (scenario === 'prefix-drift') {
      expect(result).toEqual({
        status: 'blocked',
        reason: 'MANUAL_REVIEW_REQUIRED',
      });
      expect(fixture.uploads()).toBe(3);
      expect(h.durable().evidence.images).toHaveLength(3);
      await expect(page.locator('#body')).toContainText('尾段');
      expect(fixture.saves()).toBe(1);
      expect(events.filter((event) => event.failure)).toEqual([]);
      expect(
        events.some(
          (event) =>
            event.bodyImage?.index === 3 &&
            event.bodyImage.stage === 'readback',
        ),
      ).toBe(true);
      expect(JSON.stringify(events)).not.toMatch(
        /前文|尾段|图片后续正文|https:|innerHTML|stack|bytes/,
      );
      return;
    }
    if (operatorSubmission) expect(result.status).toBe('submission_recorded');
    else
      expect(result, JSON.stringify(events)).toEqual({
        status: 'blocked',
        reason: 'MANUAL_REVIEW_REQUIRED',
      });
    expect(h.durable().evidence.images).toHaveLength(
      ['five', 'five-alternating'].includes(scenario) ? 5 : 3,
    );
    const imageCount = ['five', 'five-alternating'].includes(scenario) ? 5 : 3;
    expect(fixture.uploads()).toBe(imageCount);
    expect(fixture.saves()).toBe(1);
    expect(inputActions).toEqual(
      Array.from({ length: imageCount }, (_, index) => ({
        mode:
          scenario === 'five-alternating'
            ? ['retained', 'cleared', 'unmounted'][index % 3]
            : 'rebuilt',
        selected: 1,
        confirmed: 1,
      })),
    );
    expect(caretBeforeSave).toEqual(
      scenario === 'ending'
        ? {
            active: true,
            collapsed: true,
            inTail: false,
            offset: body.blocks.length - 1,
            atFinalImageBoundary: true,
          }
        : {
            active: true,
            collapsed: true,
            inTail: true,
            offset: 0,
            atFinalImageBoundary: false,
          },
    );
    expect(fixture.coverActions()).toBe(0);
    const observed = beforeHome ?? (await pages.inspectRichEditor!());
    if (scenario === 'structured')
      expect(observed.rich.formatKnown, JSON.stringify(observed.rich)).toBe(
        true,
      );
    expect(
      observed.rich.blocks.map((block) =>
        block.type === 'image'
          ? '[image]'
          : block.type === 'paragraph'
            ? block.content.map((run) => run.text).join('')
            : block.type,
      ),
    ).toEqual(
      [
        ...(scenario === 'image-normalization' ? [paragraph('')] : []),
        ...body.blocks,
      ].map((block) =>
        block.type === 'image'
          ? '[image]'
          : block.type === 'paragraph'
            ? block.content.map((run) => run.text).join('')
            : block.type,
      ),
    );
    // Source blanks are content, while only one final insertion caret remains.
    expect(
      beforeHomeChildren ?? (await page.locator('#body > *').count()),
    ).toBe(body.blocks.length + (scenario === 'image-normalization' ? 2 : 1));
    if (scenario === 'formatted') {
      const formatted = observed.rich.blocks[2];
      expect(
        formatted.type === 'paragraph' && formatted.content[0].marks,
      ).toEqual(['bold']);
    }
    if (scenario === 'structured') {
      expect(observed.rich.blocks).toEqual(
        body.blocks.map((block) =>
          block.type === 'image'
            ? expect.objectContaining({ type: 'image', loaded: true })
            : block,
        ),
      );
    }
  });
}
