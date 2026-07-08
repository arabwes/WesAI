import { useCallback, useEffect, useRef, useState } from "react";

/** Poll an async fetcher on an interval; exposes data / error / reload. */
export function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs = 10000
): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const reload = useCallback(() => {
    fetcherRef
      .current()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    reload();
    const id = setInterval(reload, intervalMs);
    return () => clearInterval(id);
  }, [reload, intervalMs]);

  return { data, error, reload };
}
