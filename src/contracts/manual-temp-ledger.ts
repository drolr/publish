import { z } from 'zod';
const uuid = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
export const tempSessionId = uuid;
export const tempIdentity = z
  .object({
    dev: z.string().regex(/^\d+$/),
    ino: z.string().regex(/^\d+$/),
    birth: z.string().regex(/^\d+$/),
  })
  .strict();
const fileIdentity = tempIdentity
  .extend({
    size: z.string().regex(/^\d+$/),
    mtime: z.string().regex(/^\d+$/),
    ctime: z.string().regex(/^\d+$/),
  })
  .strict();
const fileBase = z
  .object({
    fileId: uuid,
    nonce: uuid,
    byteSize: z
      .number()
      .int()
      .min(1)
      .max(20 * 1024 * 1024),
  })
  .strict();
const file = z.discriminatedUnion('phase', [
  fileBase.extend({ phase: z.literal('reserved') }),
  fileBase.extend({
    phase: z.literal('sealed'),
    identity: fileIdentity,
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
]);
export const manualTempLedgerSchema = z
  .object({
    version: z.literal(1),
    root: tempIdentity,
    data: tempIdentity,
    temp: tempIdentity,
    sessions: z
      .array(
        z
          .object({
            sessionId: uuid,
            nonce: uuid,
            identity: tempIdentity.optional(),
            owner: fileIdentity.optional(),
            files: z.array(file).max(200),
          })
          .strict(),
      )
      .max(200),
  })
  .strict()
  .superRefine((ledger, ctx) => {
    const sessions = new Set<string>();
    const files = new Set<string>();
    for (const s of ledger.sessions) {
      if (sessions.has(s.sessionId) || !!s.identity !== !!s.owner)
        ctx.addIssue({ code: 'custom', message: 'Invalid ownership' });
      sessions.add(s.sessionId);
      for (const f of s.files) {
        if (files.has(f.fileId))
          ctx.addIssue({ code: 'custom', message: 'Duplicate file' });
        files.add(f.fileId);
      }
    }
  });
export type ManualTempLedger = z.infer<typeof manualTempLedgerSchema>;
export type TempFile = ManualTempLedger['sessions'][number]['files'][number];
export type TempSession = ManualTempLedger['sessions'][number];
