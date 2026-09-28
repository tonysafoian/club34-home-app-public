/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * server/__tests__/cast-verification.test.ts
 *
 * Unit tests for verifyPlaybackState in server/lib/castBroadcast.ts.
 *
 * Covers the announce-mode fix (Task #411):
 *  1. All speakers idle + urlMatch=true  → all verified (success)
 *  2. One speaker unavailable            → that speaker fails (genuine partial)
 *  3. One speaker urlMatch=false         → that speaker fails (genuine partial)
 *  4. Normal mode: speaker playing + urlMatch=true → verified
 *  5. Normal mode: speaker idle  + urlMatch=true → NOT verified
 *  6. State fetch HTTP error             → not verified (safe fallback)
 *  7. State fetch network timeout        → not verified (safe fallback)
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

// ── Mock the guarded transport before importing the module under test ────────
// verifyPlaybackState fetches HA through the SSRF-guarded transport
// (server/lib/ssrfGuard.ts guardedFetch), not global fetch, so mock that.

const mockFetch = vi.hoisted(() => vi.fn());
vi.mock('../lib/ssrfGuard.js', () => ({ guardedFetch: mockFetch }));

// ── Import after mocking ─────────────────────────────────────────────────────

import { verifyPlaybackState } from '../lib/castBroadcast.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const HA_URL = 'http://homeassistant.local:8123';
const HA_TOKEN = 'test-token';
const ENTITY = 'media_player.bedroom_speaker';
const AUDIO_URL = 'http://localhost:5000/storage/v1/object/public/voice-replies/broadcasts/school-morning-broadcast-1234567890.mp3';

function makeHAStateResponse(state: string, mediaContentId: string | null) {
  return {
    state,
    attributes: {
      ...(mediaContentId !== null ? { media_content_id: mediaContentId } : {}),
    },
  };
}

function mockOkFetch(body: object) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => body,
  } as any);
}

function mockErrorFetch(status: number) {
  mockFetch.mockResolvedValueOnce({ ok: false, status } as any);
}

afterEach(() => {
  vi.clearAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('verifyPlaybackState — announce mode (announce:true)', () => {
  it('verifies when state=idle and urlMatch=true (normal healthy broadcast)', async () => {
    mockOkFetch(makeHAStateResponse('idle', AUDIO_URL));
    const result = await verifyPlaybackState(HA_URL, HA_TOKEN, ENTITY, AUDIO_URL, true);
    expect(result.verified).toBe(true);
    expect(result.state).toBe('idle');
    expect(result.urlMatch).toBe(true);
  });

  it('verifies when state=playing and urlMatch=true (speaker happened to still be playing)', async () => {
    mockOkFetch(makeHAStateResponse('playing', AUDIO_URL));
    const result = await verifyPlaybackState(HA_URL, HA_TOKEN, ENTITY, AUDIO_URL, true);
    expect(result.verified).toBe(true);
    expect(result.urlMatch).toBe(true);
  });

  it('fails when state=unavailable (device genuinely unreachable)', async () => {
    mockOkFetch(makeHAStateResponse('unavailable', AUDIO_URL));
    const result = await verifyPlaybackState(HA_URL, HA_TOKEN, ENTITY, AUDIO_URL, true);
    expect(result.verified).toBe(false);
    expect(result.state).toBe('unavailable');
    expect(result.urlMatch).toBe(true);
  });

  it('fails when urlMatch=false (wrong content loaded — genuine Cast drop)', async () => {
    const staleUrl = 'http://localhost:5000/storage/v1/object/public/voice-replies/broadcasts/old-broadcast.mp3';
    mockOkFetch(makeHAStateResponse('idle', staleUrl));
    const result = await verifyPlaybackState(HA_URL, HA_TOKEN, ENTITY, AUDIO_URL, true);
    expect(result.verified).toBe(false);
    expect(result.urlMatch).toBe(false);
  });

  it('fails when media_content_id is absent (content never loaded)', async () => {
    mockOkFetch(makeHAStateResponse('idle', null));
    const result = await verifyPlaybackState(HA_URL, HA_TOKEN, ENTITY, AUDIO_URL, true);
    expect(result.verified).toBe(false);
    expect(result.urlMatch).toBe(false);
  });
});

describe('verifyPlaybackState — normal mode (announce:false, default)', () => {
  it('verifies when state=playing and urlMatch=true', async () => {
    mockOkFetch(makeHAStateResponse('playing', AUDIO_URL));
    const result = await verifyPlaybackState(HA_URL, HA_TOKEN, ENTITY, AUDIO_URL);
    expect(result.verified).toBe(true);
  });

  it('does NOT verify when state=idle even if urlMatch=true', async () => {
    mockOkFetch(makeHAStateResponse('idle', AUDIO_URL));
    const result = await verifyPlaybackState(HA_URL, HA_TOKEN, ENTITY, AUDIO_URL);
    expect(result.verified).toBe(false);
    expect(result.urlMatch).toBe(true);
  });

  it('does NOT verify when state=playing but urlMatch=false (stale state, new audio)', async () => {
    const staleUrl = 'http://localhost:5000/storage/v1/object/public/voice-replies/broadcasts/old-broadcast.mp3';
    mockOkFetch(makeHAStateResponse('playing', staleUrl));
    const result = await verifyPlaybackState(HA_URL, HA_TOKEN, ENTITY, AUDIO_URL);
    expect(result.verified).toBe(false);
    expect(result.urlMatch).toBe(false);
  });
});

describe('verifyPlaybackState — error handling', () => {
  it('returns not-verified on HTTP error from HA (both modes)', async () => {
    mockErrorFetch(502);
    const resultAnnounce = await verifyPlaybackState(HA_URL, HA_TOKEN, ENTITY, AUDIO_URL, true);
    expect(resultAnnounce.verified).toBe(false);
    expect(resultAnnounce.state).toBeNull();

    mockErrorFetch(502);
    const resultNormal = await verifyPlaybackState(HA_URL, HA_TOKEN, ENTITY, AUDIO_URL, false);
    expect(resultNormal.verified).toBe(false);
    expect(resultNormal.state).toBeNull();
  });

  it('returns not-verified when fetch throws (network error / timeout)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network timeout'));
    const result = await verifyPlaybackState(HA_URL, HA_TOKEN, ENTITY, AUDIO_URL, true);
    expect(result.verified).toBe(false);
    expect(result.state).toBeNull();
    expect(result.urlMatch).toBeNull();
  });
});
