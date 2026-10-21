import { useEffect, useRef } from 'react';

// Follow a poll's live-update stream (Server-Sent Events). Anything sent while
// disconnected — a phone asleep, a dropped connection — is lost, so also
// refresh when the stream reconnects and when the page comes back into view.
export function useLiveUpdates(url: string | null, onChange: () => void) {
  const latest = useRef(onChange);
  latest.current = onChange;

  useEffect(() => {
    if (!url) return;
    const source = new EventSource(url);
    let connectedBefore = false;
    source.onmessage = () => latest.current();
    source.onopen = () => {
      if (connectedBefore) latest.current(); // a reconnect: catch up on what was missed
      connectedBefore = true;
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') latest.current();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      source.close();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [url]);
}
