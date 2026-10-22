import {
  ManualDraftSchema,
  type ManualDraft,
  type ManualState,
  type ManualArticleApi,
} from '../../contracts/manual-article';
import type { DocumentCommand, DraftRange } from '../../contracts/manual-edit';
export type EditorSessionState = Extract<ManualState, { sessionId: string }>;
export const isEditorSession = (
  state: ManualState | null,
): state is EditorSessionState => !!state && 'sessionId' in state;
export const documentTicket = (state: EditorSessionState): DocumentCommand => ({
  sessionId: state.sessionId,
  expectedDocumentRevision: state.documentRevision,
  clientSequence: state.nextClientSequence,
  commandId: state.nextEditCommandId,
});
/** Temporary renderer projection only. Main supplies every revision and sequence ticket. */
export class EditorSession {
  snapshot: ManualState | null = null;
  draft: ManualDraft | null = null;
  range: DraftRange | undefined;
  unknown = false;
  syncing = false;
  notice = '';
  private generation = 0;
  private version = 0;
  private acknowledged = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private task: Promise<boolean> | undefined;
  private frozen: { command: DocumentCommand; version: number } | undefined;
  private readUnavailable = false;
  private compositions = new Set<'body' | 'title'>();
  private waiters = new Set<() => void>();
  constructor(
    private api: Pick<ManualArticleApi, 'applyManualEdit'>,
    private notify: () => void,
  ) {}
  get unsynced() {
    return this.version !== this.acknowledged;
  }
  get composing() {
    return this.compositions.size > 0;
  }
  accept(value: ManualState, preserve = this.unsynced || this.composing) {
    const prior = this.snapshot;
    if (prior && value.revision < prior.revision) return false;
    if (value.state === 'unavailable' && isEditorSession(prior)) {
      this.readUnavailable = true;
      this.unknown = true;
      this.notice = '文章状态暂时无法确认，正在核对；当前输入已保留。';
      this.notify();
      return false;
    }
    if (
      this.readUnavailable &&
      isEditorSession(value) &&
      value.state === 'editing'
    ) {
      this.readUnavailable = false;
      this.unknown = !!this.frozen;
    }
    const same =
      isEditorSession(prior) &&
      isEditorSession(value) &&
      prior.sessionId === value.sessionId;
    if (!same) {
      this.version = 0;
      this.acknowledged = 0;
      this.frozen = undefined;
      this.unknown = false;
      this.range = undefined;
      this.compositions.clear();
    }
    this.snapshot = value;
    if (this.frozen && isEditorSession(value) && value.state === 'editing') {
      const { command, version } = this.frozen;
      const ack = value.acknowledgedEdit;
      if (
        ack?.commandId === command.commandId &&
        ack.clientSequence === command.clientSequence
      ) {
        this.acknowledged = version;
        this.frozen = undefined;
        this.unknown = false;
        preserve = this.unsynced;
        this.notice = '已核对已同步内容。';
      } else if (value.nextClientSequence > command.clientSequence) {
        this.frozen = undefined;
        this.unknown = false;
        this.notice = '上次输入未获确认，请检查后继续同步。';
      }
    }
    if (!same || !preserve) {
      this.draft = isEditorSession(value) ? value.draft : null;
      this.acknowledged = this.version;
    }
    this.notify();
    return true;
  }
  change(draft: ManualDraft) {
    if (this.unknown || this.snapshot?.state !== 'editing') return;
    if (JSON.stringify(draft) === JSON.stringify(this.draft)) return;
    this.draft = draft;
    this.version++;
    this.notice = '';
    this.notify();
    clearTimeout(this.timer);
    if (!this.composing) this.timer = setTimeout(() => void this.flush(), 100);
  }
  composition(field: 'body' | 'title', active: boolean) {
    if (active) {
      this.compositions.add(field);
      clearTimeout(this.timer);
    } else {
      this.compositions.delete(field);
      if (!this.composing) {
        for (const resolve of this.waiters) resolve();
        this.waiters.clear();
        if (this.unsynced)
          this.timer = setTimeout(() => void this.flush(), 100);
      }
    }
    this.notify();
  }
  async waitForComposition() {
    if (this.composing)
      await new Promise<void>((resolve) => this.waiters.add(resolve));
  }
  flush(): Promise<boolean> {
    clearTimeout(this.timer);
    if (this.task) return this.task;
    const pending = this.run(this.generation).finally(() => {
      if (this.task !== pending) return;
      this.task = undefined;
      this.syncing = false;
      this.notify();
    });
    this.task = pending;
    return pending;
  }
  /** Called only after main confirms all writers stopped; retain unsaved text/images. */
  initializeAfterStop() {
    this.generation++;
    clearTimeout(this.timer);
    this.task = undefined;
    this.syncing = false;
    this.frozen = undefined;
    this.unknown = false;
    this.readUnavailable = false;
    this.notice = '';
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
    this.notify();
  }
  private async run(generation: number) {
    await this.waitForComposition();
    if (generation !== this.generation) return false;
    while (this.unsynced) {
      const state = this.snapshot;
      if (generation !== this.generation) return false;
      if (
        !isEditorSession(state) ||
        state.state !== 'editing' ||
        !this.draft ||
        this.unknown
      )
        return false;
      const draft = structuredClone(this.draft),
        version = this.version,
        command = documentTicket(state);
      if (!ManualDraftSchema.safeParse(draft).success) {
        this.notice =
          '输入内容超出支持范围，请缩减标题、段落或图片数量后重试。';
        this.notify();
        return false;
      }
      this.syncing = true;
      this.notify();
      try {
        const reply = await this.api.applyManualEdit(command, draft);
        if (generation !== this.generation) return false;
        const ack = isEditorSession(reply.snapshot)
          ? reply.snapshot.acknowledgedEdit
          : null;
        if (
          reply.status === 'ok' &&
          isEditorSession(reply.snapshot) &&
          reply.snapshot.sessionId === command.sessionId &&
          ack?.commandId === command.commandId &&
          ack.clientSequence === command.clientSequence
        ) {
          this.acknowledged = version;
          this.accept(reply.snapshot, version !== this.version);
        } else {
          this.accept(reply.snapshot, true);
          if (reply.status === 'ok') {
            this.frozen = { command, version };
            this.unknown = true;
            this.notice = '同步结果暂时无法确认，正在核对已确认内容…';
            this.notify();
            return false;
          }
          this.notice =
            reply.status === 'conflict'
              ? '文章已发生变化，请核对后重新修改。'
              : '输入暂未确认，请检查标题、正文及图片后继续。';
          this.notify();
          return false;
        }
      } catch {
        if (generation !== this.generation) return false;
        this.frozen = { command, version };
        this.unknown = true;
        this.notice = '状态暂时无法确认，正在核对已同步的内容…';
        this.notify();
        return false;
      }
      if (this.composing) await this.waitForComposition();
    }
    return !this.unknown;
  }
  dispose() {
    clearTimeout(this.timer);
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }
}
