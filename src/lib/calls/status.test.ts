import { describe, expect, it } from "vitest";
import { getCallStatusLabel } from "./status";

describe("call status labels", () => {
  it("keeps normal M2 uploads clearly queued for the next milestone", () => {
    expect(getCallStatusLabel("queued")).toBe("Queued for M3");
    expect(getCallStatusLabel("test_completed")).toBe("Synthetic test complete");
  });

  it.each([
    ["uploaded", "Uploaded"],
    ["processing", "Processing"],
    ["completed", "Analysis complete"],
    ["failed", "Processing failed"],
    ["review_required", "Review required"],
    ["future_status", "Status unavailable"],
  ])("labels %s without implying AI analysis", (status, label) => {
    expect(getCallStatusLabel(status)).toBe(label);
  });
});
