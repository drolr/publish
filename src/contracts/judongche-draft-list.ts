import { z } from 'zod';

export const draftListResponseSchema = z.object({
  status: z.literal(0),
  data: z.object({
    count: z.number().int().nonnegative(),
    has_more: z.literal(false),
    list: z.array(
      z.object({ title: z.string().min(1), pgc_status: z.literal(3) }),
    ),
  }),
});
