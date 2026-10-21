import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  DRAFT_STORAGE_KEY_PREFIX,
  getDraftStorageKey,
  handoverDraftToSession,
  useChatInputDraft,
} from "./chatInputDraft";

/**
 * Mounts the real draft hook. ChatPage's integration suite mocks
 * setTextareaValue, so it cannot show whether the composer is cleared.
 */

function Harness({ sessionId }: { sessionId?: string }) {
  useChatInputDraft(true, "agent-a", sessionId);
  return (
    <div className="sender">
      <textarea aria-label="composer" />
    </div>
  );
}

function Switchable() {
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  useChatInputDraft(true, "agent-a", sessionId);
  return (
    <>
      <button type="button" onClick={() => setSessionId("session-b")}>
        open-b
      </button>
      <button type="button" onClick={() => setSessionId(undefined)}>
        open-new
      </button>
      <button type="button" onClick={() => setSessionId("real-session")}>
        open-real
      </button>
      <div className="sender">
        <textarea aria-label="composer" />
      </div>
    </>
  );
}

function composer(): HTMLTextAreaElement {
  const textarea = screen.getByRole("textbox", { name: "composer" });
  if (!(textarea instanceof HTMLTextAreaElement)) {
    throw new Error("composer is not a textarea");
  }
  return textarea;
}

function typeIntoComposer(value: string) {
  const textarea = composer();
  textarea.value = value;
  textarea.selectionStart = value.length;
  textarea.selectionEnd = value.length;
  fireEvent.input(textarea);
  return textarea;
}

afterEach(() => {
  localStorage.clear();
});

describe("useChatInputDraft (#8351)", () => {
  it("does not restore a legacy per-agent draft on a new chat", () => {
    const legacy = `${DRAFT_STORAGE_KEY_PREFIX}_agent-a`;
    localStorage.setItem(
      legacy,
      JSON.stringify({
        value: "stale legacy",
        selectionStart: 0,
        selectionEnd: 0,
      }),
    );
    render(<Harness />);
    expect(composer().value).toBe("");
    expect(localStorage.getItem(legacy)).toBeNull();
    expect(localStorage.getItem(getDraftStorageKey("agent-a"))).toBeNull();
  });

  it("does not restore a legacy per-agent draft into an existing session", () => {
    const legacy = `${DRAFT_STORAGE_KEY_PREFIX}_agent-a`;
    localStorage.setItem(
      legacy,
      JSON.stringify({
        value: "stale legacy",
        selectionStart: 0,
        selectionEnd: 0,
      }),
    );
    render(<Harness sessionId="session-a" />);
    expect(composer().value).toBe("");
    expect(
      localStorage.getItem(getDraftStorageKey("agent-a", "session-a")),
    ).toBeNull();
    expect(localStorage.getItem(legacy)).toBeNull();
  });

  it("keeps the follow-up when the blank route becomes a real session", () => {
    render(<Switchable />);
    const textarea = typeIntoComposer("follow up");
    act(() => {
      handoverDraftToSession("agent-a", "real-session");
    });
    fireEvent.click(screen.getByRole("button", { name: "open-real" }));
    expect(textarea.value).toBe("follow up");
    expect(
      localStorage.getItem(getDraftStorageKey("agent-a", "real-session")),
    ).toContain("follow up");
    expect(localStorage.getItem(getDraftStorageKey("agent-a"))).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "open-new" }));
    expect(textarea.value).toBe("");
    expect(
      localStorage.getItem(getDraftStorageKey("agent-a", "real-session")),
    ).toContain("follow up");
  });

  it("does not carry a blank-route draft into a different session", () => {
    render(<Switchable />);
    typeIntoComposer("only new");
    fireEvent.click(screen.getByRole("button", { name: "open-b" }));
    const textarea = composer();
    expect(textarea.value).toBe("");
    expect(
      localStorage.getItem(getDraftStorageKey("agent-a", "session-b")),
    ).toBeNull();
    expect(localStorage.getItem(getDraftStorageKey("agent-a"))).toContain(
      "only new",
    );
    fireEvent.click(screen.getByRole("button", { name: "open-new" }));
    expect(textarea.value).toBe("only new");
  });

  it("restores the same session after leaving and coming back (#4774)", () => {
    const view = render(<Harness sessionId="session-a" />);
    typeIntoComposer("keep me");
    view.unmount();
    render(<Harness sessionId="session-a" />);
    expect(composer().value).toBe("keep me");
  });
});
