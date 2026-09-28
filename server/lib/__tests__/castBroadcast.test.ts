/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// verifyPlaybackState fetches HA through the SSRF-guarded transport
// (server/lib/ssrfGuard.ts guardedFetch), not global fetch — mock that module.
const guardedFetchMock = vi.hoisted(() => vi.fn());
vi.mock("../ssrfGuard.js", () => ({ guardedFetch: guardedFetchMock }));

import { verifyPlaybackState } from "../castBroadcast.js";

/**
 * Regression coverage for the false "0-of-3 verified" alarm bug.
 *
 * The bug: a school-morning broadcast plays via Google Cast with
 * `announce: true`. Cast keeps the speaker at state='idle' while the
 * announcement plays "over" the device, so requiring state==='playing'
 * (the normal-mode rule) could NEVER be satisfied — every speaker was
 * reported as failed even though audio played correctly.
 *
 * verifyPlaybackState therefore takes an `announceMode` flag. In announce
 * mode a speaker is verified when the content matches (urlMatch===true) and
 * the device is reachable (state!=='unavailable'). Genuine failures
 * (urlMatch===false or 'unavailable') must still be detected.
 *
 * These tests mock the HA `/api/states/:entityId` fetch rather than hitting
 * a real Home Assistant instance.
 */

const HA_URL = "https://ha.example.test";
const HA_TOKEN = "test-token";
const EXPECTED_URL =
  "https://club34.replit.app/storage/v1/object/public/voice-replies/broadcasts/school-morning-123.mp3";

/**
 * Build a mock for global.fetch that resolves the HA states endpoint to a
 * caller-supplied state map keyed by entity_id. Each entry controls the
 * `state` and `media_content_id` returned for that speaker.
 */
function mockHaStates(
  states: Record<string, { state: string; contentId?: string | null; httpOk?: boolean }>,
) {
  guardedFetchMock.mockImplementation(async (input: any) => {
    const url = typeof input === "string" ? input : String(input);
    const entityId = url.split("/api/states/")[1] ?? "";
    const entry = states[entityId];
    if (!entry || entry.httpOk === false) {
      return { ok: false, json: async () => ({}) } as any;
    }
    return {
      ok: true,
      json: async () => ({
        state: entry.state,
        attributes: { media_content_id: entry.contentId ?? null },
      }),
    } as any;
  });
  return guardedFetchMock;
}

beforeEach(() => {
  guardedFetchMock.mockReset();
});

afterEach(() => {
  guardedFetchMock.mockReset();
});

describe("verifyPlaybackState — announce mode (school-morning broadcast)", () => {
  it("verifies all speakers when each is idle + urlMatch=true (the success case)", async () => {
    const speakers = [
      "media_player.bedroom_1",
      "media_player.bedroom_2",
      "media_player.bedroom_3",
    ];
    mockHaStates({
      [speakers[0]]: { state: "idle", contentId: EXPECTED_URL },
      [speakers[1]]: { state: "idle", contentId: EXPECTED_URL },
      [speakers[2]]: { state: "idle", contentId: EXPECTED_URL },
    });

    const results = await Promise.all(
      speakers.map((id) =>
        verifyPlaybackState(HA_URL, HA_TOKEN, id, EXPECTED_URL, true),
      ),
    );

    expect(results.every((r) => r.verified)).toBe(true);
    for (const r of results) {
      expect(r.verified).toBe(true);
      expect(r.urlMatch).toBe(true);
      expect(r.state).toBe("idle");
    }
  });

  it("fails the one speaker that is unavailable (partial success)", async () => {
    const ok = "media_player.bedroom_1";
    const down = "media_player.bedroom_2";
    mockHaStates({
      [ok]: { state: "idle", contentId: EXPECTED_URL },
      [down]: { state: "unavailable", contentId: EXPECTED_URL },
    });

    const okResult = await verifyPlaybackState(HA_URL, HA_TOKEN, ok, EXPECTED_URL, true);
    const downResult = await verifyPlaybackState(HA_URL, HA_TOKEN, down, EXPECTED_URL, true);

    expect(okResult.verified).toBe(true);
    expect(downResult.verified).toBe(false);
    expect(downResult.state).toBe("unavailable");
  });

  it("fails the one speaker whose loaded content does not match (urlMatch=false)", async () => {
    const ok = "media_player.bedroom_1";
    const stale = "media_player.bedroom_2";
    mockHaStates({
      [ok]: { state: "idle", contentId: EXPECTED_URL },
      [stale]: { state: "idle", contentId: "https://example.test/some-other-old.mp3" },
    });

    const okResult = await verifyPlaybackState(HA_URL, HA_TOKEN, ok, EXPECTED_URL, true);
    const staleResult = await verifyPlaybackState(HA_URL, HA_TOKEN, stale, EXPECTED_URL, true);

    expect(okResult.verified).toBe(true);
    expect(staleResult.verified).toBe(false);
    expect(staleResult.urlMatch).toBe(false);
  });
});

describe("verifyPlaybackState — normal mode", () => {
  it("verifies a speaker that is playing + urlMatch=true", async () => {
    const id = "media_player.kitchen";
    mockHaStates({ [id]: { state: "playing", contentId: EXPECTED_URL } });

    const result = await verifyPlaybackState(HA_URL, HA_TOKEN, id, EXPECTED_URL, false);

    expect(result.verified).toBe(true);
    expect(result.state).toBe("playing");
    expect(result.urlMatch).toBe(true);
  });

  it("does NOT verify a speaker that is idle even when urlMatch=true", async () => {
    const id = "media_player.kitchen";
    mockHaStates({ [id]: { state: "idle", contentId: EXPECTED_URL } });

    const result = await verifyPlaybackState(HA_URL, HA_TOKEN, id, EXPECTED_URL, false);

    expect(result.verified).toBe(false);
    expect(result.state).toBe("idle");
    expect(result.urlMatch).toBe(true);
  });
});

describe("verifyPlaybackState — failure handling", () => {
  it("returns not-verified when the HA request is not ok", async () => {
    const id = "media_player.kitchen";
    mockHaStates({ [id]: { state: "playing", contentId: EXPECTED_URL, httpOk: false } });

    const result = await verifyPlaybackState(HA_URL, HA_TOKEN, id, EXPECTED_URL, true);

    expect(result.verified).toBe(false);
    expect(result.state).toBeNull();
    expect(result.urlMatch).toBeNull();
  });

  it("returns not-verified when the fetch throws", async () => {
    guardedFetchMock.mockImplementation(async () => {
      throw new Error("network down");
    });

    const result = await verifyPlaybackState(
      HA_URL,
      HA_TOKEN,
      "media_player.kitchen",
      EXPECTED_URL,
      true,
    );

    expect(result.verified).toBe(false);
    expect(result.state).toBeNull();
  });
});
