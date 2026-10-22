import {
  DeclarationKeysSchema,
  DeclarationChangeSchema,
  DeclarationReadResultSchema,
  DeclarationWriteResultSchema,
  type DeclarationChange,
  type DeclarationReadResult,
  type DeclarationWriteResult,
} from '../contracts/article-declaration';
import type { ArticleRepository } from '../domain/ports/article-import';

function matchesRequest(
  result: DeclarationReadResult | DeclarationWriteResult,
  keys: string[],
): boolean {
  if ('items' in result)
    return (
      result.items.length === keys.length &&
      result.items.every((item) => keys.includes(item.articleKey))
    );
  if ('articleKeys' in result)
    return result.articleKeys.every((key) => keys.includes(key));
  return true;
}
export function createArticleDeclarations(
  repository: ArticleRepository,
  gate: () => 'ready' | 'busy' | 'unavailable',
) {
  return {
    getArticleDeclarations(articleKeys: string[]): DeclarationReadResult {
      try {
        const keys = DeclarationKeysSchema.parse(articleKeys);
        if (gate() !== 'ready' || !repository.getArticleDeclarations)
          return { status: 'unavailable' };
        const result = DeclarationReadResultSchema.parse(
          repository.getArticleDeclarations(keys),
        );
        return matchesRequest(result, keys)
          ? result
          : { status: 'unavailable' };
      } catch {
        return { status: 'unavailable' };
      }
    },
    setArticleDeclarations(input: DeclarationChange): DeclarationWriteResult {
      try {
        const change = DeclarationChangeSchema.parse(input);
        const state = gate();
        if (state !== 'ready') return { status: state };
        if (!repository.setArticleDeclarations)
          return { status: 'unavailable' };
        const result = DeclarationWriteResultSchema.parse(
          repository.setArticleDeclarations(change),
        );
        if (
          !matchesRequest(
            result,
            change.targets.map((target) => target.articleKey),
          )
        )
          return { status: 'unavailable' };
        if (
          result.status === 'updated' &&
          result.items.some(
            (item) => item.contentDeclaration !== change.declaration,
          )
        )
          return { status: 'unavailable' };
        return result;
      } catch {
        return { status: 'unavailable' };
      }
    },
  };
}
