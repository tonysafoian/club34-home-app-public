import { describe, it, expect } from "vitest";
import {
  resolveInitialCategory,
  resolveCategoryToSave,
} from "../device-category";
import type { ConnectedDevice } from "../types";

function device(overrides: Partial<ConnectedDevice> = {}): ConnectedDevice {
  return {
    hostname: null,
    ip: null,
    mac: "a2:bb:cc:dd:ee:01",
    ...overrides,
  } as ConnectedDevice;
}

describe("resolveInitialCategory", () => {
  it("pre-fills 'People / Personal Devices' for a randomized device that would otherwise be Unknown", () => {
    expect(
      resolveInitialCategory(device({ is_random: true, category: "Unknown / Uncategorized" })),
    ).toBe("People / Personal Devices");
  });

  it("pre-fills 'People / Personal Devices' for a randomized device with no category", () => {
    expect(
      resolveInitialCategory(device({ is_random: true, category: undefined })),
    ).toBe("People / Personal Devices");
  });

  it("respects an existing meaningful category override on a randomized device", () => {
    expect(
      resolveInitialCategory(device({ is_random: true, category: "Smart Speakers" })),
    ).toBe("Smart Speakers");
  });

  it("uses the device category as-is for non-randomized devices", () => {
    expect(
      resolveInitialCategory(device({ is_random: false, category: "Security Cameras" })),
    ).toBe("Security Cameras");
  });

  it("falls back to empty (auto-detect) for a non-randomized device with no category", () => {
    expect(
      resolveInitialCategory(device({ is_random: false, category: undefined })),
    ).toBe("");
  });
});

describe("resolveCategoryToSave", () => {
  it("anchors 'People / Personal Devices' when a randomized device is saved with no explicit category", () => {
    expect(resolveCategoryToSave("", device({ is_random: true }))).toBe(
      "People / Personal Devices",
    );
  });

  it("persists the chosen category when one is selected on a randomized device", () => {
    expect(resolveCategoryToSave("Smart TVs & Streaming", device({ is_random: true }))).toBe(
      "Smart TVs & Streaming",
    );
  });

  it("saves null (auto-detect) for a non-randomized device with no explicit category", () => {
    expect(resolveCategoryToSave("", device({ is_random: false }))).toBeNull();
  });
});
