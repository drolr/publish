import type { z } from 'zod';
const messages = {
  UNSUPPORTED_VERSION: '文章包版本无法识别，请使用第 1 版格式。',
  INVALID_STRUCTURE: '文章内容格式不完整，请检查标注的位置。',
  MISSING_TITLE: '文章缺少标题，请补充后重试。',
  EMPTY_BODY: '文章缺少正文段落，请补充后重试。',
  INVALID_IDENTIFIER: '文章或图片标识格式不正确，请检查后重试。',
  DUPLICATE_IMAGE: '图片标识重复，请为每张图片使用不同标识。',
  MISSING_IMAGE: '正文引用的图片没有提供，请补充图片。',
  UNUSED_IMAGE: '有图片未指定正文位置，请补充位置或移除。',
  INVALID_IMAGE_SOURCE: '图片来源格式不正确，请重新提供。',
  INPUT_LIMIT_EXCEEDED: '文章内容超出当前支持范围，请减少后重试。',
} as const;
export type ArticleIssueCode = keyof typeof messages;
export interface ArticleIssue {
  code: ArticleIssueCode;
  message: string;
  path: (string | number)[];
}
export interface ArticleWarning {
  code: 'SOURCE_METADATA_IGNORED';
  message: string;
}
export const ignoredMetadataWarning: ArticleWarning = {
  code: 'SOURCE_METADATA_IGNORED',
  message: '当前版本只处理文章正文和图片，附带的来源信息未保留。',
};
const knownFields = new Set([
  'schema_version',
  'article_id',
  'title',
  'body',
  'images',
  'content_declaration',
  'type',
  'text',
  'image_id',
  'source',
  'path',
  'url',
]);
export function mapIssues(issues: readonly z.core.$ZodIssue[]): ArticleIssue[] {
  return issues.slice(0, 50).map((issue) => {
    const customCode: unknown =
      issue.code === 'custom' ? issue.params?.contractCode : undefined;
    let code: ArticleIssueCode = 'INVALID_STRUCTURE';
    if (typeof customCode === 'string' && Object.hasOwn(messages, customCode))
      code = customCode as ArticleIssueCode;
    else if (issue.code !== 'unrecognized_keys') {
      if (issue.path.includes('source')) code = 'INVALID_IMAGE_SOURCE';
      else if (
        issue.path.includes('article_id') ||
        issue.path.includes('image_id')
      )
        code = 'INVALID_IDENTIFIER';
    }
    const path = issue.path.filter(
      (part): part is string | number =>
        (typeof part === 'number' && Number.isSafeInteger(part) && part >= 0) ||
        (typeof part === 'string' && knownFields.has(part)),
    );
    return { code, message: messages[code], path };
  });
}
