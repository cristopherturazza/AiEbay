import { describe, expect, it } from "vitest";
import { SellbotError } from "../src/errors.js";
import { parseAuthorizationCodeFromInput } from "../src/services/auth-flow.js";

describe("auth-flow", () => {
  it("estrae il code da un redirect URL e valida lo state", () => {
    const code = parseAuthorizationCodeFromInput(
      "https://auth2.ebay.com/oauth2/ThirdPartyAuthSucessFailure?state=abc123&code=test-code",
      "abc123"
    );

    expect(code).toBe("test-code");
  });

  it("accetta il code raw", () => {
    expect(parseAuthorizationCodeFromInput("raw-code-value", "ignored-state")).toBe("raw-code-value");
  });

  it("fallisce se lo state non combacia", () => {
    expect(() =>
      parseAuthorizationCodeFromInput("https://example.com/callback?state=wrong&code=test-code", "expected")
    ).toThrowError(SellbotError);
  });
});
