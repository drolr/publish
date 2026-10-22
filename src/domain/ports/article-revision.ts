import type {
  EditableArticle,
  EditorCompatibilityLease,
  RevisionCommitResult,
  RevisionIntent,
  RevisionOperation,
  RevisionOperationPatch,
  RevisionProposal,
  SaveLookup,
  SaveReceipt,
} from '../../contracts/article-revision';
export interface ArticleRevisionRepository {
  createEditorCompatibilityLease(
    articleKey: string,
    sessionId: string,
    baseRevision: number,
  ): EditorCompatibilityLease | undefined;
  isEditorCompatibilityLease(
    lease: EditorCompatibilityLease,
    articleKey: string,
    sessionId: string,
    baseRevision: number,
  ): boolean;
  releaseEditorCompatibilityLease(lease: EditorCompatibilityLease): void;
  loadEditableArticle(articleKey: string): EditableArticle | undefined;
  loadArchivedEditableArticle(articleKey: string): EditableArticle | undefined;
  readSaveReceipt(operationId: string): SaveReceipt | undefined;
  readRevisionOperation(operationId: string): RevisionOperation | undefined;
  beginRevision(intent: RevisionIntent): SaveLookup;
  commitRevision(
    expectedRevision: number,
    proposal: RevisionProposal,
    receipt: SaveReceipt,
  ): RevisionCommitResult;
  listRevisionOperations(): RevisionOperation[];
  markRevisionOperation(
    operationId: string,
    patch: RevisionOperationPatch,
  ): void;
}
