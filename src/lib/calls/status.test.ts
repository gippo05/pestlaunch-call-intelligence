import { describe, expect, it } from "vitest";
import { getAnalysisEmptyState, getAnalysisReviewSectionHeading, getCallStatusLabel, hasActiveM3Call, isM3CallStatusActive } from "./status";

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

  it("refreshes only while a call is queued or processing", () => {
    expect(isM3CallStatusActive("queued")).toBe(true);
    expect(isM3CallStatusActive("processing")).toBe(true);
    expect(isM3CallStatusActive("failed")).toBe(false);
    expect(hasActiveM3Call(["completed", "queued"])).toBe(true);
    expect(hasActiveM3Call(["completed", "failed"])).toBe(false);
  });
});

describe("call analysis review labels", () => {
  it("labels extracted items as candidates until a human reviews them", () => {
    expect(getAnalysisReviewSectionHeading("facts")).toBe("AI-extracted fact candidates");
    expect(getAnalysisReviewSectionHeading("concerns")).toBe("AI-extracted concern candidates");
  });

  it.each([
    ["queued", "Awaiting analysis", "The recording is stored privately. No transcript, outcome, or score has been generated yet."],
    ["processing", "Analysis in progress", "M3 processing is underway. The recording remains private, and no transcript, outcome, or score is available yet."],
    ["failed", "Analysis failed", "M3 processing failed before an analysis was saved. The recording remains private. No transcript, outcome, or score is available."],
  ])("uses the %s state in the detail placeholder", (status, heading, description) => {
    expect(getAnalysisEmptyState(status)).toEqual({ heading, description });
  });
});
