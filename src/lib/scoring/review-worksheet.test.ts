import { describe, expect, it } from "vitest";
import { DEFAULT_RUBRIC_REGISTRY } from "./rubrics.ts";
import { parseWorksheetInput, summarizeReviewWorksheet } from "./review-worksheet.ts";

const sales = DEFAULT_RUBRIC_REGISTRY["abc.sales"];
const transcript = "Caller: I heard a noise. Agent: Thank you for calling. Agent: May I ask a question?";
const met = {
  criterionId: "sales.thank_customer", status: "met", evidenceQuote: "Agent: Thank you for calling.",
  rationale: "Agent explicitly thanked the customer.", agentConfirmed: true,
};
describe("M4 reviewer worksheet", () => {
  it("never converts an unreviewed blank worksheet into a zero performance grade", () => {
    const result = summarizeReviewWorksheet({ observations: [], wholeCallReviewed: false, objectionState: "unknown" }, sales);
    expect(result.confirmedPoints).toBe(0);
    expect(result.covered).toBe(0);
    expect(result.incomplete).toBe(17);
    expect(result.provisionalGrade).toBeNull();
  });
  it("accepts only exact, speaker-confirmed evidence", () => {
    expect(() => parseWorksheetInput({ observations: [{ ...met, evidenceQuote: "Made-up quote" }], wholeCallReviewed: false, objectionState: "unknown" }, sales, transcript)).toThrow();
    expect(() => parseWorksheetInput({ observations: [{ ...met, agentConfirmed: false }], wholeCallReviewed: false, objectionState: "unknown" }, sales, transcript)).toThrow();
    const input = parseWorksheetInput({ observations: [met], wholeCallReviewed: false, objectionState: "unknown" }, sales, transcript);
    const summary = summarizeReviewWorksheet(input, sales);
    expect(summary.covered).toBe(1);
    expect(summary.confirmedPoints).toBe(1);
    expect(summary.provisionalGrade).toBeNull();
  });
  it("rejects duplicated criterion IDs and fake missed assessments without whole-call review", () => {
    expect(() => parseWorksheetInput({ observations: [met, met], wholeCallReviewed: false, objectionState: "unknown" }, sales, transcript)).toThrow();
    expect(() => parseWorksheetInput({ observations: [{ ...met, status: "missed" }], wholeCallReviewed: false, objectionState: "unknown" }, sales, transcript)).toThrow();
  });
  it("awards exactly four objection points only after confirmed no-objection whole-call review", () => {
    expect(() => parseWorksheetInput({ observations: [], wholeCallReviewed: false, objectionState: "none_confirmed" }, sales, transcript)).toThrow();
    const result = summarizeReviewWorksheet({ observations: [], wholeCallReviewed: true, objectionState: "none_confirmed" }, sales);
    expect(result.covered).toBe(4);
    expect(result.confirmedPoints).toBe(4);
    expect(result.criteria.filter((c) => c.status === "auto_awarded")).toHaveLength(4);
    expect(result.provisionalGrade).toBeNull();
  });
  it("keeps the two Expectation Statement rows distinct", () => {
    const result = summarizeReviewWorksheet({ observations: [], wholeCallReviewed: false, objectionState: "unknown" }, sales);
    expect(result.criteria.filter(c => c.label === "Expectation Statement").map(c => c.id)).toEqual([
      "sales.expectation_statement.first", "sales.expectation_statement.second",
    ]);
  });
  it("uses 12-point office scoring without sales objection auto-awards", () => {
    const rubric = DEFAULT_RUBRIC_REGISTRY["noble_sales.general_office"];
    const result = summarizeReviewWorksheet({ observations: [], wholeCallReviewed: true, objectionState: "none_confirmed" }, rubric);
    expect(result.maxPoints).toBe(12);
    expect(result.covered).toBe(0);
  });
});
