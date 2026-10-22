import ts from 'typescript';
import { builtinModules } from 'node:module';
import { posix } from 'node:path';
const external: Record<string, string[]> = {
  domain: [],
  contracts: ['zod'],
  application: [],
  renderer: [
    'react',
    'react-dom',
    'prosemirror-model',
    'prosemirror-state',
    'prosemirror-view',
    'prosemirror-transform',
    'prosemirror-history',
    'prosemirror-commands',
    'prosemirror-keymap',
  ],
  desktop: ['electron'],
  infrastructure: [],
};
const inward: Record<string, string[]> = {
  domain: ['domain', 'contracts'],
  contracts: ['contracts'],
  application: ['application', 'domain', 'contracts'],
  renderer: ['renderer', 'contracts'],
  desktop: ['desktop', 'application', 'infrastructure', 'domain', 'contracts'],
  infrastructure: ['infrastructure', 'application', 'domain', 'contracts'],
};
const browserRuntime = /^(playwright|playwright-core)(\/|$)/;
const browserOwner = (path: string) =>
  path.startsWith('src/infrastructure/automation/') ||
  path.startsWith('src/infrastructure/platforms/judongche/');
const moduleKey = (path: string) =>
  path.replace(/\.(tsx?|jsx?)$/, '').replace(/\/index$/, '');

// Track raw browser aliases through local reexports; they cannot become
// inward contracts simply by adding an intermediate local barrel.
function browserReexports(
  files: ReadonlyArray<{ path: string; source: string }>,
): Set<string> {
  const exposed = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const file of files) {
      const path = file.path.replaceAll('\\', '/');
      const key = moduleKey(path);
      if (exposed.has(key)) continue;
      const tree = ts.createSourceFile(
        path,
        file.source,
        ts.ScriptTarget.Latest,
        true,
      );
      const contaminated = (specifier: string) =>
        browserRuntime.test(specifier) ||
        (specifier.startsWith('.') &&
          exposed.has(moduleKey(posix.join(posix.dirname(path), specifier))));
      const aliases = new Set<string>();
      for (const node of tree.statements) {
        if (
          ts.isImportDeclaration(node) &&
          ts.isStringLiteral(node.moduleSpecifier) &&
          contaminated(node.moduleSpecifier.text)
        ) {
          const bindings = node.importClause?.namedBindings;
          if (bindings && ts.isNamedImports(bindings))
            for (const item of bindings.elements) aliases.add(item.name.text);
          if (bindings && ts.isNamespaceImport(bindings))
            aliases.add(bindings.name.text);
        }
      }
      let aliasChanged = true;
      while (aliasChanged) {
        aliasChanged = false;
        for (const node of tree.statements) {
          if (
            (!ts.isTypeAliasDeclaration(node) &&
              !ts.isInterfaceDeclaration(node)) ||
            aliases.has(node.name.text)
          )
            continue;
          let contaminatedType = false;
          const inspect = (child: ts.Node) => {
            if (ts.isIdentifier(child) && aliases.has(child.text))
              contaminatedType = true;
            if (
              ts.isImportTypeNode(child) &&
              ts.isLiteralTypeNode(child.argument) &&
              ts.isStringLiteral(child.argument.literal) &&
              contaminated(child.argument.literal.text)
            )
              contaminatedType = true;
            ts.forEachChild(child, inspect);
          };
          if (ts.isTypeAliasDeclaration(node)) inspect(node.type);
          else node.heritageClauses?.forEach(inspect);
          if (contaminatedType) {
            aliases.add(node.name.text);
            aliasChanged = true;
          }
        }
      }
      let exportsBrowser = false;
      for (const node of tree.statements) {
        if (ts.isExportDeclaration(node)) {
          if (
            node.moduleSpecifier &&
            ts.isStringLiteral(node.moduleSpecifier) &&
            contaminated(node.moduleSpecifier.text)
          )
            exportsBrowser = true;
          if (
            !node.moduleSpecifier &&
            node.exportClause &&
            ts.isNamedExports(node.exportClause) &&
            node.exportClause.elements.some((item) =>
              aliases.has((item.propertyName ?? item.name).text),
            )
          )
            exportsBrowser = true;
        }
        if (
          (ts.isTypeAliasDeclaration(node) ||
            ts.isInterfaceDeclaration(node)) &&
          aliases.has(node.name.text) &&
          node.modifiers?.some(
            (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
          )
        )
          exportsBrowser = true;
      }
      if (exportsBrowser) {
        exposed.add(key);
        changed = true;
      }
    }
  }
  return exposed;
}
export function checkBoundaries(
  files: ReadonlyArray<{ path: string; source: string }>,
): string[] {
  const errors: string[] = [];
  const exposedBrowserTypes = browserReexports(files);
  for (const file of files) {
    const path = file.path.replaceAll('\\', '/');
    if (!path.startsWith('src/')) continue;
    const layer = path.split('/')[1];
    const fail = (reason: string) => errors.push(`${path}: ${reason}`);
    if (!(layer in inward)) {
      fail('Unknown source layer');
      continue;
    }
    if (path.endsWith('.sql')) {
      if (!path.startsWith('src/infrastructure/persistence/'))
        fail('SQL outside persistence');
      continue;
    }
    const tree = ts.createSourceFile(
      path,
      file.source,
      ts.ScriptTarget.Latest,
      true,
      path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const check = (specifier: string) => {
      if (specifier.startsWith('.')) {
        const target = posix.normalize(
          posix.join(posix.dirname(path), specifier),
        );
        if (
          !target.startsWith('src/') ||
          !inward[layer].includes(target.split('/')[1])
        )
          fail(`Forbidden dependency: ${specifier}`);
        if (!browserOwner(path) && exposedBrowserTypes.has(moduleKey(target)))
          fail('Browser types reexported outside automation/Judongche');
        if (target.includes('/testing/') && !path.includes('/testing/'))
          fail('Test utilities imported by production');
        return;
      }
      if (specifier === 'htmlparser2' || specifier.startsWith('htmlparser2/')) {
        if (
          path !== 'src/infrastructure/content/web-paste-parser.ts' ||
          specifier !== 'htmlparser2'
        )
          fail('HTML parser outside approved content parser');
        return;
      }
      const builtin =
        specifier.startsWith('node:') || builtinModules.includes(specifier);
      if (specifier === 'sharp' || specifier.startsWith('sharp/')) {
        if (!path.startsWith('src/infrastructure/assets/'))
          fail('Image decoder outside assets');
        return;
      }
      if (['better-sqlite3', 'sqlite3', 'node:sqlite'].includes(specifier)) {
        if (!path.startsWith('src/infrastructure/persistence/'))
          fail('SQLite outside persistence');
        return;
      }
      if (
        builtin &&
        (layer === 'infrastructure' || path.startsWith('src/desktop/main/'))
      )
        return;
      if (/^@playwright\/test(\/|$)/.test(specifier)) {
        fail('Playwright test runner in production');
        return;
      }
      if (browserRuntime.test(specifier)) {
        if (!browserOwner(path))
          fail('Playwright outside automation/Judongche');
        return;
      }
      if (
        !(external[layer] ?? []).some(
          (name) => specifier === name || specifier.startsWith(`${name}/`),
        )
      )
        fail(`Forbidden package or unresolved alias: ${specifier}`);
    };
    const visit = (node: ts.Node) => {
      if (ts.isImportTypeNode(node)) {
        if (
          ts.isLiteralTypeNode(node.argument) &&
          ts.isStringLiteral(node.argument.literal)
        )
          check(node.argument.literal.text);
        else fail('Dynamic type module reference');
      }
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        check(node.moduleSpecifier.text);
      if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference)
      ) {
        const expression = node.moduleReference.expression;
        if (expression && ts.isStringLiteral(expression))
          check(expression.text);
        else fail('Dynamic module reference');
      }
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === 'require'))
      ) {
        const first = node.arguments[0];
        if (node.arguments.length !== 1 || !first || !ts.isStringLiteral(first))
          fail('Dynamic module loading');
        else check(first.text);
      }
      if (
        ts.isIdentifier(node) &&
        node.text === 'ipcRenderer' &&
        !path.startsWith('src/desktop/preload/')
      )
        fail('ipcRenderer outside preload');
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  return errors;
}
