import { describe, expect, it } from "vitest";
import {
  DRAFT_STORAGE_KEY_PREFIX,
  getDraftStorageKey,
  parseDraft,
  serializeDraft,
} from "./chatInputDraft";

// ---------------------------------------------------------------------------
// getDraftStorageKey — regression for A#82689956
// (drafts leaked across agents because all agents shared one storage key;
// the key must be namespaced per agent so drafts stay isolated)
// ---------------------------------------------------------------------------
describe("getDraftStorageKey (A#82689956)", () => {
  it("namespaces the key with the agent id", () => {
    expect(getDraftStorageKey("agent-a")).toBe(
      `${DRAFT_STORAGE_KEY_PREFIX}_agent-a`,
    );
  });

  it("produces distinct keys for distinct agents", () => {
    // The core contract: switching agents must never surface another
    // agent's draft.
    expect(getDraftStorageKey("agent-a")).not.toBe(
      getDraftStorageKey("agent-b"),
    );
  });

  it("falls back to the shared key without an agent id", () => {
    expect(getDraftStorageKey()).toBe(DRAFT_STORAGE_KEY_PREFIX);
    expect(getDraftStorageKey(undefined)).toBe(DRAFT_STORAGE_KEY_PREFIX);
  });

  it("falls back to the shared key for a falsy agent id", () => {
    expect(getDraftStorageKey("")).toBe(DRAFT_STORAGE_KEY_PREFIX);
  });
});

// ---------------------------------------------------------------------------
// Per-session drafts — regression for #8351
// (one agent shares many conversations; the storage key must include the
// session so an unsent draft does not appear in the agent's other sessions.
// A legacy per-agent entry must not be read back for every session.)
// ---------------------------------------------------------------------------
describe("per-session chat input drafts (#8351)", () => {
  const memory = () => {
    const items = new Map<string, string>();
    return {
      get(agentId?: string, sessionId?: string) {
        return parseDraft(
          items.get(getDraftStorageKey(agentId, sessionId)) ?? null,
        );
      },
      set(
        agentId: string | undefined,
        sessionId: string | undefined,
        draft: { value: string; selectionStart: number; selectionEnd: number },
      ) {
        const key = getDraftStorageKey(agentId, sessionId);
        const serialized = serializeDraft(draft);
        if (serialized) items.set(key, serialized);
        else items.delete(key);
      },
      raw(agentId?: string, sessionId?: string) {
        return items.get(getDraftStorageKey(agentId, sessionId)) ?? null;
      },
    };
  };

  it("keys a saved draft by agent and session", () => {
    expect(getDraftStorageKey("agent-a", "session-1")).toBe(
      `${DRAFT_STORAGE_KEY_PREFIX}_agent-a_session-1`,
    );
  });

  it("gives each session of one agent its own key", () => {
    expect(getDraftStorageKey("agent-a", "session-1")).not.toBe(
      getDraftStorageKey("agent-a", "session-2"),
    );
    expect(getDraftStorageKey("agent-a", "session-1")).not.toBe(
      getDraftStorageKey("agent-b", "session-1"),
    );
  });

  it("keeps the legacy per-agent key only when no session exists yet", () => {
    expect(getDraftStorageKey("agent-a")).toBe(
      `${DRAFT_STORAGE_KEY_PREFIX}_agent-a`,
    );
    expect(getDraftStorageKey("agent-a", undefined)).toBe(
      `${DRAFT_STORAGE_KEY_PREFIX}_agent-a`,
    );
    expect(getDraftStorageKey("agent-a", "")).toBe(
      `${DRAFT_STORAGE_KEY_PREFIX}_agent-a`,
    );
    expect(getDraftStorageKey("agent-a", "new")).toBe(
      `${DRAFT_STORAGE_KEY_PREFIX}_agent-a`,
    );
    expect(getDraftStorageKey("agent-a", "session-1")).not.toBe(
      getDraftStorageKey("agent-a"),
    );
  });

  it("restores the draft saved for that session and not another session", () => {
    const storage = memory();
    const draftA = { value: "only A", selectionStart: 1, selectionEnd: 4 };
    storage.set("agent-a", "session-a", draftA);
    storage.set("agent-a", "session-b", {
      value: "only B",
      selectionStart: 0,
      selectionEnd: 0,
    });

    expect(storage.get("agent-a", "session-a")).toEqual(draftA);
    expect(storage.get("agent-a", "session-b")?.value).toBe("only B");
    expect(storage.get("agent-b", "session-a")).toBeNull();
  });

  it("does not load a legacy per-agent draft into every session", () => {
    const storage = memory();
    storage.set("agent-a", undefined, {
      value: "stale shared draft",
      selectionStart: 0,
      selectionEnd: 0,
    });

    expect(storage.get("agent-a", "session-a")).toBeNull();
    expect(storage.get("agent-a", "session-b")).toBeNull();
    expect(storage.get("agent-a")?.value).toBe("stale shared draft");
  });

  it("removes an empty draft from that session only", () => {
    const storage = memory();
    storage.set("agent-a", "session-a", {
      value: "gone",
      selectionStart: 0,
      selectionEnd: 0,
    });
    storage.set("agent-a", "session-b", {
      value: "keep",
      selectionStart: 2,
      selectionEnd: 2,
    });
    storage.set("agent-a", "session-a", {
      value: "",
      selectionStart: 0,
      selectionEnd: 0,
    });

    expect(storage.get("agent-a", "session-a")).toBeNull();
    expect(storage.raw("agent-a", "session-a")).toBeNull();
    expect(storage.get("agent-a", "session-b")?.value).toBe("keep");
  });
});

// ---------------------------------------------------------------------------
// serializeDraft / parseDraft — regression for #4774
// (navigating away and back must restore the draft exactly; empty drafts
// must be removed, malformed stored data must never throw)
// ---------------------------------------------------------------------------
describe("draft serialize/parse round-trip (#4774)", () => {
  it("round-trips value and cursor selection", () => {
    const draft = { value: "hello draft", selectionStart: 2, selectionEnd: 5 };
    expect(parseDraft(serializeDraft(draft))).toEqual(draft);
  });

  it("returns null for an empty value so callers remove the stored draft", () => {
    expect(
      serializeDraft({ value: "", selectionStart: 0, selectionEnd: 0 }),
    ).toBeNull();
  });

  it("returns null for missing or empty stored data", () => {
    expect(parseDraft(null)).toBeNull();
    expect(parseDraft("")).toBeNull();
  });

  it("fails soft on malformed JSON instead of throwing", () => {
    expect(parseDraft("{not valid json")).toBeNull();
  });

  it("returns null when the parsed draft has an empty value", () => {
    expect(
      parseDraft(
        JSON.stringify({ value: "", selectionStart: 0, selectionEnd: 0 }),
      ),
    ).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Draft cleared after send — regression for A#82576583
  // After a message is sent, the draft must be cleared so it doesn't resurface
  // on the next visit. serializeDraft returns null for an empty draft,
  // signaling callers to removeItem from storage.
  // -------------------------------------------------------------------------
  it("serializeDraft returns null after send clears the draft (A#82576583)", () => {
    // Simulate: user had a draft, then sent the message (value becomes "")
    const afterSend = { value: "", selectionStart: 0, selectionEnd: 0 };
    const serialized = serializeDraft(afterSend);
    // null signals callers to removeItem — draft must not persist
    expect(serialized).toBeNull();
    // And parsing null returns null — no stale draft resurfaces
    expect(parseDraft(serialized)).toBeNull();
  });

  it("round-trip: non-empty draft survives, empty draft is removed (A#82576583)", () => {
    // User types something
    const typed = { value: "hello", selectionStart: 5, selectionEnd: 5 };
    expect(parseDraft(serializeDraft(typed))).toEqual(typed);

    // User sends the message → draft cleared
    const cleared = { value: "", selectionStart: 0, selectionEnd: 0 };
    expect(serializeDraft(cleared)).toBeNull();
    expect(parseDraft(null)).toBeNull();
  });
});
