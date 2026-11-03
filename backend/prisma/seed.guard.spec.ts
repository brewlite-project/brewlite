import { describe, expect, it } from "vitest";
import { isSeedDatabaseAllowed } from "./seed.js";

const composeUrl =
  "postgresql://seed_user:seed_password@postgres:5432/brewlite_compose?schema=public";

describe("catalog seed database guard", () => {
  it("allows the exact Compose database only with the explicit flag", () => {
    expect(isSeedDatabaseAllowed(composeUrl, "true")).toBe(true);
  });

  it("rejects the Compose database when the explicit flag is missing", () => {
    expect(isSeedDatabaseAllowed(composeUrl, undefined)).toBe(false);
  });

  it.each([
    "postgresql://seed_user:seed_password@not-postgres:5432/brewlite_compose?schema=public",
    "postgresql://seed_user:seed_password@postgres:5433/brewlite_compose?schema=public",
  ])("rejects a Compose-like URL with host or port outside the allowlist", (url) => {
    expect(isSeedDatabaseAllowed(url, "true")).toBe(false);
  });

  it("rejects another database even with the explicit flag", () => {
    expect(
      isSeedDatabaseAllowed(
        "postgresql://seed_user:seed_password@postgres:5432/brewlite_test?schema=public",
        "true",
      ),
    ).toBe(false);
  });

  it("preserves the existing brewlite_seed_* allowlist", () => {
    expect(
      isSeedDatabaseAllowed(
        "postgresql://seed_user:seed_password@other-host:5433/brewlite_seed_catalog_v21?schema=public",
        undefined,
      ),
    ).toBe(true);
  });
});
