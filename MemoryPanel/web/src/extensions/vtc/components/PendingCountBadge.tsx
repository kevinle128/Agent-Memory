import { useEffect, useState } from 'react';
import { PENDING_CHANGED_EVENT, vtcApi } from '../api';

const POLL_MS = 60_000;

/** Count of people who wait for an administrator. Shows nothing at 0 or when the count can not be read. */
export default function PendingCountBadge() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      vtcApi
        .count()
        .then((value) => {
          if (alive) setCount(value);
        })
        .catch(() => {
          if (alive) setCount(0);
        });
    };
    refresh();
    const timer = window.setInterval(refresh, POLL_MS);
    window.addEventListener(PENDING_CHANGED_EVENT, refresh);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener(PENDING_CHANGED_EVENT, refresh);
    };
  }, []);

  if (count <= 0) return null;
  // The menu text column is narrow, so an inline badge wraps under the label. Anchoring to the (relative) menu
  // item keeps it on the label line, and a plain red pill shows in every theme and in the selected state.
  return (
    <span
      aria-label={String(count)}
      style={{
        position: 'absolute',
        right: 12,
        top: '50%',
        transform: 'translateY(-50%)',
        minWidth: 18,
        height: 18,
        padding: '0 5px',
        boxSizing: 'border-box',
        borderRadius: 9,
        background: '#e54545',
        color: '#fff',
        fontSize: 11,
        fontWeight: 600,
        lineHeight: '18px',
        textAlign: 'center',
        whiteSpace: 'nowrap',
      }}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}
