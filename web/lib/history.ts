/**
 * Local history of entered YouTube links (persisted in localStorage), so past
 * links can be re-used quickly. Independent of the backend library.
 */

const KEY = 'ytx-url-history-v1';
const MAX = 25;

export interface HistoryEntry {
  url: string;
  title?: string;
  at: string; // ISO
}

export function getHistory(): HistoryEntry[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

function save(entries: HistoryEntry[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries.slice(0, MAX)));
  } catch {
    /* storage full / unavailable — ignore */
  }
}

/** Add (or move to front) a URL, keeping the most-recent first and deduped. */
export function addToHistory(url: string, title?: string): HistoryEntry[] {
  const trimmed = url.trim();
  if (!trimmed) return getHistory();
  const existing = getHistory().filter((e) => e.url !== trimmed);
  const entry: HistoryEntry = {
    url: trimmed,
    title: title ?? existing.find((e) => e.url === trimmed)?.title,
    at: new Date().toISOString(),
  };
  const next = [entry, ...existing];
  save(next);
  return next;
}

export function removeFromHistory(url: string): HistoryEntry[] {
  const next = getHistory().filter((e) => e.url !== url);
  save(next);
  return next;
}

export function clearHistory(): HistoryEntry[] {
  save([]);
  return [];
}
