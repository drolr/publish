import { useEffect, useRef, useState } from 'react';
import { BatchViewSchema, type BatchView } from '../../contracts/draft-batch';
let read: Promise<BatchView | null> | undefined;
function readCurrent() {
  if (!read) {
    const pending = Promise.resolve()
      .then(() => window.desktopApi.batch.getCurrent())
      .then((value) => BatchViewSchema.nullable().parse(value))
      .finally(() => {
        if (read === pending) read = undefined;
      });
    read = pending;
  }
  return read;
}
export function useBatch(resetRevision = 0) {
  const [view, setView] = useState<BatchView | null>(null);
  const [unknown, setUnknown] = useState(true);
  const latest = useRef<BatchView | null>(null);
  const alive = useRef(false);
  const revision = useRef(0);
  function accept(value: BatchView | null) {
    if (!alive.current) return;
    if (
      latest.current &&
      value &&
      value.id === latest.current.id &&
      value.revision < latest.current.revision
    )
      return;
    latest.current = value;
    setView(value);
    setUnknown(false);
  }
  async function refresh() {
    const ticket = revision.current;
    try {
      const value = await readCurrent();
      if (ticket === revision.current) accept(value);
    } catch {
      if (alive.current && ticket === revision.current) setUnknown(true);
    }
  }
  function update(value: BatchView | null) {
    revision.current++;
    accept(value);
  }
  useEffect(() => {
    alive.current = true;
    revision.current++;
    if (resetRevision > 0) read = undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      timeout = setTimeout(() => {
        if (!cancelled) setUnknown(true);
      }, 10000);
      await refresh();
      clearTimeout(timeout);
      if (!cancelled) timer = setTimeout(() => void poll(), 1000);
    };
    void poll();
    return () => {
      alive.current = false;
      cancelled = true;
      clearTimeout(timer);
      clearTimeout(timeout);
    };
  }, [resetRevision]);
  return { view, unknown, update, refresh };
}
