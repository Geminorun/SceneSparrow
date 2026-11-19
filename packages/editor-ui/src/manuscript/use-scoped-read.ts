import { useCallback, useEffect, useRef, useState } from "react";
import { useNoticeOwner } from "../feedback/NotificationPresenter";

/** Read failures belong to the selected surface and exact page request. Later
 * selections revoke both late results and the compact retry capability. */
export function useScopedRead(owner: unknown, context: string | null) {
  const current = useRef({ owner, context });
  current.current = { owner, context };
  const lifetime = useRef(0),
    mounted = useRef(true);
  const requests = useRef(new Map<string, number>());
  const notice = useNoticeOwner();
  const [recovery, setRecovery] = useState<{
    key: string;
    code: string;
    retry: () => void;
  } | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      lifetime.current++;
    };
  }, []);
  useEffect(() => {
    setRecovery(null);
    notice.resolve();
  }, [owner, context]);
  const invalidate = useCallback(() => {
    lifetime.current++;
    setRecovery(null);
    notice.resolve();
  }, [notice.resolve]);
  async function run<T>(
    key: string,
    read: () => Promise<T>,
    apply: (value: T) => void,
    passive = false,
    belongs?: () => boolean,
  ): Promise<void> {
    const captured = current.current,
      version = lifetime.current;
    const request = (requests.current.get(key) ?? 0) + 1;
    requests.current.set(key, request);
    const valid = () =>
      mounted.current &&
      (!belongs || belongs()) &&
      lifetime.current === version &&
      current.current.owner === captured.owner &&
      current.current.context === captured.context &&
      requests.current.get(key) === request;
    if (!passive) notice.resolve(key);
    try {
      const value = await read();
      if (!valid()) return;
      apply(value);
      setRecovery((previous) => (previous?.key === key ? null : previous));
    } catch (failure) {
      if (!valid() || passive) return;
      const retry = () => {
        if (valid()) void run(key, read, apply, false, belongs);
      };
      setRecovery({
        key,
        code:
          failure instanceof Error ? failure.message : "STORAGE_UNAVAILABLE",
        retry,
      });
      notice.report(failure, {
        identity: key,
        actions: [{ kind: "recovery", run: retry }],
      });
    }
  }
  return { run, recovery, invalidate };
}
