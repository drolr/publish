import { expect, it } from 'vitest';
import {
  PersistedEditorBodyV1Schema,
  DocumentCommandSchema,
  DraftRangeSchema,
} from '../../src/contracts/manual-edit';
import {
  normalizeEditorBody,
  projectEditorBody,
} from '../../src/domain/article-edit';
import { randomUUID } from 'node:crypto';
it('legacy_empty_lines_and_repeated_images preserves whitespace and image positions', () => {
  const body = {
    version: 1 as const,
    blocks: [
      { type: 'paragraph' as const, text: '' },
      { type: 'paragraph' as const, text: '  汉😀\n文  ' },
      ...Array.from({ length: 201 }, () => ({
        type: 'image' as const,
        imageId: 'front',
      })),
      { type: 'paragraph' as const, text: ' \n ' },
    ],
  };
  expect(normalizeEditorBody(body)).toEqual(body);
  expect(projectEditorBody(body)).toEqual(
    body.blocks
      .slice(1, -1)
      .map((block) =>
        block.type === 'image'
          ? { type: 'image', image_id: block.imageId }
          : block,
      ),
  );
});
it('counts code points and empty blocks within unchanged budgets, rejecting unsafe snapshot', () => {
  expect(
    PersistedEditorBodyV1Schema.safeParse({
      version: 1,
      blocks: [{ type: 'paragraph', text: '😀'.repeat(20000) }],
    }).success,
  ).toBe(true);
  for (const blocks of [
    [{ type: 'paragraph', text: '😀'.repeat(20001) }],
    Array.from({ length: 1001 }, () => ({ type: 'paragraph', text: '' })),
    Array.from({ length: 11 }, () => ({
      type: 'paragraph',
      text: 'a'.repeat(20000),
    })),
  ])
    expect(
      PersistedEditorBodyV1Schema.safeParse({ version: 1, blocks }).success,
    ).toBe(false);
  expect(
    PersistedEditorBodyV1Schema.safeParse({
      version: 1,
      blocks: [{ type: 'paragraph', text: '\u0000'.repeat(20000) }],
      html: 'unsafe',
    }).success,
  ).toBe(false);
});
it('commands and range contracts are strict and offsets are safe integers', () => {
  const command = {
    sessionId: randomUUID(),
    expectedDocumentRevision: 0,
    clientSequence: 1,
    commandId: randomUUID(),
  };
  expect(DocumentCommandSchema.parse(command)).toEqual(command);
  expect(
    DocumentCommandSchema.safeParse({ ...command, path: 'secret' }).success,
  ).toBe(false);
  expect(
    DraftRangeSchema.safeParse({
      anchor: { blockKey: randomUUID(), kind: 'text', offset: -1 },
      head: { blockKey: randomUUID(), kind: 'edge', side: 'after' },
    }).success,
  ).toBe(false);
});

it('empty paragraphs count as blocks and snapshot rejects oversized untrusted input', () => {
  expect(
    PersistedEditorBodyV1Schema.safeParse({
      version: 1,
      blocks: Array.from({ length: 1000 }, () => ({
        type: 'paragraph',
        text: '',
      })),
    }).success,
  ).toBe(true);
  expect(
    PersistedEditorBodyV1Schema.safeParse({
      version: 1,
      blocks: [{ type: 'paragraph', text: '正文' }],
      untrusted: 'x'.repeat(2 * 1024 * 1024),
    }).success,
  ).toBe(false);
});
