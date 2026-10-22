import { expect, it } from 'vitest';
import { checkBoundaries } from '../../scripts/boundaries';
const invalid: [string, string][] = [
  ['application/a.ts', "import sharp from 'sharp'"],
  ['infrastructure/persistence/a.ts', "import sharp from 'sharp'"],
  ['renderer/a.ts', "import sharp from 'sharp'"],
  [
    'domain/a.ts',
    "export type Store = typeof import('../infrastructure/persistence/database').openBaselineStore",
  ],
  ['domain/a.ts', "export type Fs = typeof import('node:fs')"],
  ['domain/a.ts', "import fs from 'node:fs'"],
  ['domain/a.ts', "export * from 'react'"],
  ['renderer/a.ts', "import x from '../infrastructure/x'"],
  ['renderer/a.ts', "const x = require('better-sqlite3')"],
  ['application/a.ts', "import('playwright')"],
  ['application/a.ts', "import x from '@app/infrastructure/x'"],
  ['application/a.ts', 'import(path)'],
  ['application/a.ts', "import fs from 'fs'"],
  ['unknown/a.ts', "import x from 'react'"],
  ['infrastructure/assets/a.ts', "import { ipcRenderer } from 'electron'"],
  ['contracts/a.ts', "import fs from 'node:fs'"],
  ['infrastructure/assets/a.ts', "import { DatabaseSync } from 'node:sqlite'"],
];
it.each(invalid)('rejects forbidden import in %s: %s', (path, source) => {
  expect(checkBoundaries([{ path: `src/${path}`, source }])).not.toEqual([]);
});
it('accepts approved inward dependencies and type-only bridge contracts', () => {
  expect(
    checkBoundaries([
      {
        path: 'src/renderer/a.ts',
        source: "import type { DesktopApi } from '../contracts/app-status'",
      },
      {
        path: 'src/application/a.ts',
        source: "import type { Store } from '../domain/ports/store'",
      },
      {
        path: 'src/infrastructure/persistence/a.ts',
        source: "import Database from 'better-sqlite3'",
      },
    ]),
  ).toEqual([]);
});
it.each([
  'domain/a.ts',
  'application/a.ts',
  'renderer/a.ts',
  'infrastructure/content/a.ts',
  'desktop/main/a.ts',
  'contracts/a.ts',
])('restricts htmlparser2 to the one approved parser: %s', (path) => {
  expect(
    checkBoundaries([
      { path: `src/${path}`, source: "import { Parser } from 'htmlparser2'" },
    ]),
  ).not.toEqual([]);
});
it('accepts htmlparser2 only in the exact approved parser file', () => {
  expect(
    checkBoundaries([
      {
        path: 'src/infrastructure/content/web-paste-parser.ts',
        source: "import { Parser } from 'htmlparser2'",
      },
    ]),
  ).toEqual([]);
});
it('does not let another infrastructure file bypass the parser restriction with a subpath', () => {
  expect(
    checkBoundaries([
      {
        path: 'src/infrastructure/content/web-paste-worker.ts',
        source: "import { Parser } from 'htmlparser2/lib/Parser'",
      },
    ]),
  ).not.toEqual([]);
});

const browserSyntax = [
  "import { Page } from 'playwright-core'",
  "export type { Page } from 'playwright-core'",
  "type P = import('playwright-core').Page",
  "const p = require('playwright-core')",
  "const p = import('playwright-core')",
];
it.each([
  'application',
  'contracts',
  'renderer',
  'infrastructure/assets',
  'infrastructure/platforms/other',
  'infrastructure/platforms/judongche-lookalike',
])('rejects every browser import form in %s', (layer) => {
  for (const source of browserSyntax)
    expect(
      checkBoundaries([{ path: `src/${layer}/a.ts`, source }]),
    ).not.toEqual([]);
});
it('permits runtime use only in automation and the exact Judongche subtree', () => {
  for (const layer of [
    'infrastructure/automation',
    'infrastructure/platforms/judongche',
  ]) {
    for (const source of browserSyntax)
      expect(checkBoundaries([{ path: `src/${layer}/a.ts`, source }])).toEqual(
        [],
      );
  }
});
it('rejects the Playwright test runner throughout production source', () => {
  for (const layer of [
    'infrastructure/automation',
    'infrastructure/platforms/judongche',
  ]) {
    expect(
      checkBoundaries([
        {
          path: `src/${layer}/a.ts`,
          source: "import { test } from '@playwright/test'",
        },
      ]),
    ).not.toEqual([]);
  }
});
it('rejects browser types smuggled via local reexports into other infrastructure or desktop', () => {
  for (const consumer of [
    'src/infrastructure/assets/a.ts',
    'src/desktop/main/a.ts',
  ]) {
    expect(
      checkBoundaries([
        {
          path: 'src/infrastructure/automation/types.ts',
          source: "export type { Page as RemotePage } from 'playwright-core'",
        },
        {
          path: 'src/infrastructure/automation/barrel.ts',
          source: "export * from './types'",
        },
        {
          path: consumer,
          source:
            "import type { RemotePage } from '../../infrastructure/automation/barrel'",
        },
      ]),
    ).not.toEqual([]);
  }
});

it('follows browser type reexports through directory-index barrels and local aliases', () => {
  for (const source of [
    "export type { Page } from 'playwright-core'",
    "import type { Page } from 'playwright-core'; type Local = Page; export type Remote = Local",
  ]) {
    expect(
      checkBoundaries([
        { path: 'src/infrastructure/automation/types/index.ts', source },
        {
          path: 'src/infrastructure/automation/barrel.ts',
          source: "export * from './types'",
        },
        {
          path: 'src/desktop/main/a.ts',
          source:
            "type P = import('../../infrastructure/automation/barrel').Remote",
        },
      ]),
    ).not.toEqual([]);
  }
});

const inheritedBrowserTypes = [
  "import type { Page } from 'playwright-core'; export interface RemotePage extends Page {}",
  "import type { Locator } from 'playwright-core'; interface Local extends Locator {}; export interface RemotePage extends Local {}",
  "import type * as PW from 'playwright-core'; export interface RemotePage extends PW.Page {}",
  "import type { Page } from 'playwright-core'; export interface RemotePage extends Alias {}; type Alias = Local; interface Local extends Page {}",
  "import type { Page } from 'playwright-core'; interface Local extends Page {}; export type RemotePage = Local",
  "import type { Page } from 'playwright-core'; interface Local extends Page {}; export { Local as RemotePage }",
];
it.each(inheritedBrowserTypes)(
  'rejects raw browser interface heritage: %s',
  (source) => {
    for (const path of [
      'src/desktop/main/a.ts',
      'src/infrastructure/assets/a.ts',
    ]) {
      expect(
        checkBoundaries([
          { path: 'src/infrastructure/automation/types/index.ts', source },
          {
            path: 'src/infrastructure/automation/barrel.ts',
            source: "export * from './types'",
          },
          {
            path,
            source:
              "import type { RemotePage } from '../../infrastructure/automation/barrel'",
          },
        ]),
      ).toContain(
        `${path}: Browser types reexported outside automation/Judongche`,
      );
    }
  },
);
it('propagates inherited browser interfaces across allowed local modules', () => {
  expect(
    checkBoundaries([
      {
        path: 'src/infrastructure/automation/base.ts',
        source:
          "import type { Page } from 'playwright-core'; export interface Base extends Page {}",
      },
      {
        path: 'src/infrastructure/automation/derived.ts',
        source:
          "import type { Base } from './base'; export interface RemotePage extends Base {}",
      },
      {
        path: 'src/infrastructure/platforms/other/a.ts',
        source: "import type { RemotePage } from '../../automation/derived'",
      },
    ]),
  ).toContain(
    'src/infrastructure/platforms/other/a.ts: Browser types reexported outside automation/Judongche',
  );
});
it('preserves main composition of the actual BrowserSession factory', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(
    'src/infrastructure/automation/browser-session.ts',
    'utf8',
  );
  expect(
    checkBoundaries([
      { path: 'src/infrastructure/automation/browser-session.ts', source },
      {
        path: 'src/desktop/main/composition.ts',
        source:
          "import { createBrowserSession } from '../../infrastructure/automation/browser-session'; const session = createBrowserSession('/app-owned/profile');",
      },
    ]),
  ).toEqual([]);
});
it('allows approved ProseMirror packages only in renderer, including type and dynamic forms', () => {
  for (const name of [
    'prosemirror-model',
    'prosemirror-state',
    'prosemirror-view',
    'prosemirror-transform',
    'prosemirror-history',
    'prosemirror-commands',
    'prosemirror-keymap',
  ]) {
    for (const source of [
      `import x from '${name}'`,
      `type X=import('${name}').Node`,
      `const x=import('${name}')`,
    ]) {
      expect(
        checkBoundaries([{ path: 'src/renderer/editor/test.ts', source }]),
      ).toEqual([]);
      for (const layer of [
        'domain',
        'application',
        'contracts',
        'desktop/main',
        'infrastructure/assets',
      ])
        expect(
          checkBoundaries([{ path: `src/${layer}/test.ts`, source }]),
        ).not.toEqual([]);
    }
  }
});
