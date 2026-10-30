import type { CallBrand, CallCategory, RubricCriterion, RubricDefinition, ScoringInput } from "./types.ts";
import { validateScoringInput } from "./input-validation.ts";

type CriterionSpec = Pick<RubricCriterion, "id" | "label" | "applicability">;

function criteriaFrom(specs: CriterionSpec[]): RubricCriterion[] {
  return specs.map((spec, index) => Object.freeze({
    ...spec,
    order: index + 1,
    weight: 1 as const,
    calibrationRequired: true as const,
  }));
}

const salesCriteria: CriterionSpec[] = [
  { id: "sales.validate", label: "Validate", applicability: "always" },
  { id: "sales.confidence_statement", label: "Confidence Statement", applicability: "always" },
  { id: "sales.expectation_statement.first", label: "Expectation Statement", applicability: "always" },
  { id: "sales.investigate", label: "Investigate", applicability: "always" },
  { id: "sales.summary_statement", label: "Summary Statement", applicability: "always" },
  { id: "sales.expectation_statement.second", label: "Expectation Statement", applicability: "always" },
  { id: "sales.present_solution", label: "Present Solution", applicability: "always" },
  { id: "sales.consensus", label: "Consensus", applicability: "always" },
  { id: "sales.close", label: "Close", applicability: "always" },
  { id: "sales.pricing", label: "Pricing", applicability: "always" },
  { id: "sales.agree", label: "Agree", applicability: "sales_objection" },
  { id: "sales.restate_insinuate", label: "Restate & Insinuate", applicability: "sales_objection" },
  { id: "sales.resolve", label: "Resolve", applicability: "sales_objection" },
  { id: "sales.reclose", label: "Re-Close", applicability: "sales_objection" },
  { id: "sales.provide_conclusion", label: "Provide a Conclusion", applicability: "always" },
  { id: "sales.offer_final_information", label: "Offer final information", applicability: "always" },
  { id: "sales.thank_customer", label: "Thank the Customer", applicability: "always" },
];

const generalOfficeCriteria: CriterionSpec[] = [
  { id: "general_office.validate", label: "Validate", applicability: "always" },
  { id: "general_office.confidence_statement", label: "Confidence Statement", applicability: "always" },
  { id: "general_office.expectation_statement.first", label: "Expectation Statement", applicability: "always" },
  { id: "general_office.investigate", label: "Investigate", applicability: "always" },
  { id: "general_office.summary_statement", label: "Summary Statement", applicability: "always" },
  { id: "general_office.expectation_statement.second", label: "Expectation Statement", applicability: "always" },
  { id: "general_office.present_solution", label: "Present Solution", applicability: "always" },
  { id: "general_office.consensus", label: "Consensus", applicability: "always" },
  { id: "general_office.close", label: "Close", applicability: "always" },
  { id: "general_office.provide_conclusion", label: "Provide a Conclusion", applicability: "always" },
  { id: "general_office.thank_customer", label: "Thank the Customer", applicability: "always" },
  { id: "general_office.offer_final_information", label: "Offer final information", applicability: "always" },
];

const retentionCriteria: CriterionSpec[] = [
  { id: "retention.validate_confidence_statement", label: "Validate & Confidence Statement", applicability: "always" },
  { id: "retention.transition_statement", label: "Transition Statement", applicability: "always" },
  { id: "retention.do_your_research", label: "Do Your Research", applicability: "always" },
  { id: "retention.investigate", label: "Investigate", applicability: "always" },
  { id: "retention.validate_summary_statement", label: "Validate & Summary Statement", applicability: "always" },
  { id: "retention.validate_expectation_statement", label: "Validate & Expectation Statement", applicability: "always" },
  { id: "retention.present_solution", label: "Present Solution", applicability: "always" },
  { id: "retention.consensus", label: "Consensus", applicability: "always" },
  { id: "retention.repeat", label: "Repeat (when necessary)", applicability: "retention_repeat" },
  { id: "retention.provide_conclusion", label: "Provide a Conclusion", applicability: "always" },
  { id: "retention.thank_customer", label: "Thank the Customer", applicability: "always" },
  { id: "retention.leave_teaser", label: "Leave a Teaser", applicability: "always" },
];

function makeRubric(
  brand: CallBrand,
  category: CallCategory,
  specs: CriterionSpec[],
  gold: number,
  greenMinimum: number,
): RubricDefinition {
  const rubricCriteria = criteriaFrom(specs);
  return Object.freeze({
    id: `${brand}.${category}.v1`,
    brand,
    category,
    version: 1,
    maxPoints: rubricCriteria.reduce((sum, criterion) => sum + criterion.weight, 0),
    thresholds: Object.freeze({ gold, greenMinimum }),
    calibrationStatus: "manual_calibration_required",
    criteria: Object.freeze(rubricCriteria),
  });
}

export const DEFAULT_RUBRIC_REGISTRY = Object.freeze({
  "abc.sales": makeRubric("abc", "sales", salesCriteria, 17, 14),
  "noble_sales.sales": makeRubric("noble_sales", "sales", salesCriteria, 17, 14),
  "abc.general_office": makeRubric("abc", "general_office", generalOfficeCriteria, 12, 11),
  "noble_sales.general_office": makeRubric("noble_sales", "general_office", generalOfficeCriteria, 12, 11),
  "abc.retention": makeRubric("abc", "retention", retentionCriteria, 12, 11),
  "noble_sales.retention": makeRubric("noble_sales", "retention", retentionCriteria, 12, 11),
});

export type RubricRegistry = typeof DEFAULT_RUBRIC_REGISTRY;

export type RubricSelection = {
  rubric: RubricDefinition | null;
  reviewRequired: boolean;
  reviewReasons: string[];
};

export function selectRubric(input: ScoringInput): RubricSelection {
  if (!validateScoringInput(input).valid) {
    return { rubric: null, reviewRequired: true, reviewReasons: ["scoring_input_invalid"] };
  }

  const reviewReasons: string[] = [];
  const brand = input.call.brand;
  const category = input.call.conversationalIntent;

  if (brand !== "abc" && brand !== "noble_sales") reviewReasons.push("unknown_brand");
  if (category !== "sales" && category !== "general_office" && category !== "retention") {
    reviewReasons.push("unknown_conversational_intent");
  }
  if (!input.call.companyConfirmed || !input.call.intentValidated) reviewReasons.push("classification_unreviewed");

  // A known, user-selected company plus a supported AI intent may select a
  // candidate rubric for an all-withheld review assessment. The AI intent is
  // still never accepted as validated classification or as point evidence.
  if (!input.call.companyConfirmed || (brand !== "abc" && brand !== "noble_sales") ||
      (category !== "sales" && category !== "general_office" && category !== "retention")) {
    return { rubric: null, reviewRequired: true, reviewReasons };
  }

  const key = `${brand}.${category}` as keyof typeof DEFAULT_RUBRIC_REGISTRY;
  const rubric = DEFAULT_RUBRIC_REGISTRY[key];
  if (!rubric) {
    return {
      rubric: null,
      reviewRequired: true,
      reviewReasons: ["unsupported_brand_category_combination"],
    };
  }

  return { rubric, reviewRequired: reviewReasons.length > 0, reviewReasons };
}

