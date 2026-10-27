import { describe, expect, it } from "vitest";
import { validateLoginCredentials } from "./credentials";

describe("validateLoginCredentials", () => {
  it("trims the email while preserving the password exactly", () => {
    expect(validateLoginCredentials("  reviewer@example.com  ", "  keep spaces  ")).toEqual({
      ok: true,
      credentials: {
        email: "reviewer@example.com",
        password: "  keep spaces  ",
      },
    });
  });

  it("rejects invalid or blank input with a generic error", () => {
    const secretPassword = "do-not-reflect-this-password";
    const result = validateLoginCredentials("not-an-email", secretPassword);

    expect(result).toEqual({ ok: false, message: "Enter a valid email and password." });
    expect(JSON.stringify(result)).not.toContain(secretPassword);
  });

  it("rejects whitespace-only passwords", () => {
    expect(validateLoginCredentials("reviewer@example.com", "   ")).toEqual({
      ok: false,
      message: "Enter a valid email and password.",
    });
  });
});
