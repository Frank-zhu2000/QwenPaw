/**
 * Pure helpers for the Chat input draft persistence.
 *
 * Extracted from Chat/index.tsx so the draft contract can be unit-tested
 * without rendering the (very large) Chat page. The draft hook
 * (`useChatInputDraft`) stays in index.tsx and consumes these helpers.
 *
 * Regressions guarded here:
 * - A#82689956: drafts must be isolated per agent (storage key carries the
 *   agent id), otherwise switching agents leaks one agent's draft into
 *   another's input box.
 * - #8351: drafts must also be isolated per session. A real session never
 *   reads the legacy per-agent key, so an old shared draft cannot appear in
 *   every conversation. A conversation that does not exist yet (no session
 *   id, or the explicit "new" route) still uses that per-agent slot.
 * - #4774: navigating away and back must restore the draft exactly (value +
 *   cursor selection), and malformed/empty stored data must never throw.
 */

export const DRAFT_STORAGE_KEY_PREFIX = "qwenpaw_chat_input_draft";

export interface DraftState {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

/**
 * Storage key for one conversation's draft.
 *
 * - No agent id: the shared key (`qwenpaw_chat_input_draft`).
 * - Agent, no session yet: `qwenpaw_chat_input_draft_<agentId>` (also the
 *   legacy slot from before drafts were per session).
 * - Agent and session: `qwenpaw_chat_input_draft_<agentId>_<sessionId>`.
 *
 * Callers must not fall back from a session key to the legacy per-agent key.
 * That fallback is what copied one unsent draft into every session (#8351).
 * The explicit `new` route is not a session; it keeps the per-agent slot.
 */
export function getDraftStorageKey(
  agentId?: string,
  sessionId?: string,
): string {
  const agentKey = agentId
    ? `${DRAFT_STORAGE_KEY_PREFIX}_${agentId}`
    : DRAFT_STORAGE_KEY_PREFIX;
  if (!sessionId || sessionId === "new") return agentKey;
  return `${agentKey}_${sessionId}`;
}

/**
 * Serializes a draft for persistence. Returns null when the value is empty —
 * callers must treat null as "remove the stored draft" (a leftover stale
 * draft would resurface on the next visit, regression #4774).
 */
export function serializeDraft(draft: DraftState): string | null {
  return draft.value ? JSON.stringify(draft) : null;
}

/**
 * Parses a stored draft. Returns null for missing, malformed, or empty
 * values — restore must fail soft and never throw on corrupted storage.
 */
export function parseDraft(raw: string | null): DraftState | null {
  if (!raw) return null;
  try {
    const draft = JSON.parse(raw) as DraftState;
    return draft.value ? draft : null;
  } catch {
    return null;
  }
}
