/**
 * Chat input draft persistence.
 *
 * The key helpers and `useChatInputDraft` live here so the composer contract
 * can be tested without rendering the Chat page.
 *
 * Regressions guarded here:
 * - A#82689956: drafts must be isolated per agent (the storage key carries the
 *   agent id), otherwise switching agents leaks one agent's draft into
 *   another's input box.
 * - #8351: every conversation of one agent used to share
 *   `qwenpaw_chat_input_draft_<agentId>`. A real session id is part of the
 *   key, including when no agent id is selected. That legacy entry is never
 *   read back. `/chat` and `/chat/new` use a pending slot, and that draft is
 *   handed to the session once an id is allocated.
 * - #4774: navigating away and back must restore the draft exactly (value +
 *   cursor selection), and malformed/empty stored data must never throw.
 * - #8272: sending clears only the current conversation's draft.
 */

import { useEffect } from "react";
import { useLoopStore } from "../../stores/loopStore";
import { setTextareaValue } from "./utils";

export const DRAFT_STORAGE_KEY_PREFIX = "qwenpaw_chat_input_draft";

/** Blank-route slot. Distinct from the pre-#8351 per-agent key. */
const PENDING_DRAFT_SUFFIX = "__pending";

export interface DraftState {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

/** Pre-#8351 key. Callers must not restore this into a composer. */
export function getLegacyDraftStorageKey(agentId?: string): string {
  return agentId
    ? `${DRAFT_STORAGE_KEY_PREFIX}_${agentId}`
    : DRAFT_STORAGE_KEY_PREFIX;
}

/**
 * Storage key for one conversation's draft.
 *
 * - No real session (missing, empty, or the explicit "new" route): one
 *   pending slot for that agent. This is not the legacy per-agent key.
 * - Real session: `qwenpaw_chat_input_draft_<agentId>_<sessionId>`.
 *   A session id is still appended when the agent id is missing.
 */
export function getDraftStorageKey(
  agentId?: string,
  sessionId?: string,
): string {
  const base = getLegacyDraftStorageKey(agentId);
  if (!sessionId || sessionId === "new") {
    return `${base}${PENDING_DRAFT_SUFFIX}`;
  }
  return `${base}_${sessionId}`;
}

/** Drop a pre-#8351 per-agent entry so it cannot resurface later. */
export function discardLegacyDraft(agentId?: string): void {
  const legacy = getLegacyDraftStorageKey(agentId);
  if (legacy !== getDraftStorageKey(agentId)) {
    localStorage.removeItem(legacy);
  }
}

/**
 * Move the blank-route draft onto a session that was just allocated.
 * Does not copy the legacy per-agent entry. Drops the pending slot so the
 * next blank chat does not inherit this text.
 */
export function handoverDraftToSession(
  agentId: string | undefined,
  sessionId: string,
): void {
  if (!sessionId || sessionId === "new") return;
  const fromKey = getDraftStorageKey(agentId);
  const toKey = getDraftStorageKey(agentId, sessionId);
  if (fromKey !== toKey) {
    const pending = localStorage.getItem(fromKey);
    if (pending && !localStorage.getItem(toKey)) {
      localStorage.setItem(toKey, pending);
    }
    localStorage.removeItem(fromKey);
  }
  discardLegacyDraft(agentId);
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

export function useChatInputDraft(
  active: boolean,
  agentId?: string,
  sessionId?: string,
) {
  const storageKey = getDraftStorageKey(agentId, sessionId);

  useEffect(() => {
    if (!active) return;
    // Ignore a pre-#8351 per-agent entry instead of restoring it (#8351).
    discardLegacyDraft(agentId);

    const getTextarea = (): HTMLTextAreaElement | null => {
      const sender = document.querySelector('[class*="sender"]');
      return sender?.querySelector("textarea") as HTMLTextAreaElement | null;
    };

    const saveDraft = (textarea: HTMLTextAreaElement) => {
      const draft: DraftState = {
        value: textarea.value,
        selectionStart: textarea.selectionStart,
        selectionEnd: textarea.selectionEnd,
      };
      const serialized = serializeDraft(draft);
      if (serialized) {
        localStorage.setItem(storageKey, serialized);
      } else {
        localStorage.removeItem(storageKey);
      }
    };

    const handleInput = (e: Event) => {
      const target = e.target as HTMLElement;
      if (target?.tagName !== "TEXTAREA") return;
      if (!target?.closest('[class*="sender"]')) return;

      saveDraft(target as HTMLTextAreaElement);

      // Minimal loop mode detection: sync indicator with availableModes
      const val = (target as HTMLTextAreaElement).value.trimStart();
      const modes = useLoopStore.getState().availableModes;
      const match = modes.find((m) => {
        if (!m.slash_command) return false;
        const prefix = `/${m.slash_command}`;
        // Match "/cmd" or "/cmd " exactly, avoid "/cmdxxx"
        return val === prefix || val.startsWith(`${prefix} `);
      });
      if (match) useLoopStore.getState().setSelectedMode(match.id);
    };

    // Read once, before the input listener, so a session switch cannot save
    // the previous conversation's text into this session's slot (#8351).
    const storedDraft = parseDraft(localStorage.getItem(storageKey));
    const applyStoredDraft = (textarea: HTMLTextAreaElement) => {
      if (storedDraft) {
        setTextareaValue(textarea, storedDraft.value);
        requestAnimationFrame(() => {
          textarea.selectionStart = storedDraft.selectionStart;
          textarea.selectionEnd = storedDraft.selectionEnd;
        });
        return;
      }
      if (textarea.value) setTextareaValue(textarea, "");
    };

    document.addEventListener("input", handleInput, true);

    // The sender textarea can already be mounted when the session changes.
    // Replace its value before the browser handles another keystroke.
    // setTextareaValue dispatches input only after the new value is in place,
    // so this save records the session's own draft (or clears an empty one).
    const existingTextarea = getTextarea();
    if (existingTextarea) applyStoredDraft(existingTextarea);

    // Restore draft on mount with polling for textarea readiness.
    let restoreAttempts = 0;
    const maxRestoreAttempts = 20;
    const restoreInterval = setInterval(() => {
      restoreAttempts++;
      const textarea = getTextarea();
      if (textarea) {
        clearInterval(restoreInterval);
        // A node that mounts later starts empty. Fill it from this session
        // only; do not wipe text the user already typed into it.
        if (textarea !== existingTextarea && !textarea.value && storedDraft) {
          applyStoredDraft(textarea);
        }
      } else if (restoreAttempts >= maxRestoreAttempts) {
        clearInterval(restoreInterval);
      }
    }, 100);

    return () => {
      clearInterval(restoreInterval);
      document.removeEventListener("input", handleInput, true);

      // Input events already saved the draft. Cleanup must not overwrite it
      // with a cleared/remounted composer (including another browser tab).
    };
  }, [active, agentId, storageKey]);
}
