import type { CleanedWhere } from "better-auth/adapters";
import { describe, expect, it } from "vitest";

import { whereToQuery } from "../src/where-to-query";

const ISO = "2026-01-02T03:04:05.000Z";
const DATE = new Date(ISO);

/** Builds a clause with better-auth's cleaned defaults. */
const clause = (overrides: Partial<CleanedWhere>): CleanedWhere => ({
  field: "email",
  value: "a@example.com",
  operator: "eq",
  connector: "AND",
  mode: "sensitive",
  ...overrides,
});

describe("whereToQuery", () => {
  it("matches everything when there are no clauses", () => {
    expect(whereToQuery([])).toEqual({ match_all: {} });
  });

  it("translates eq on a string to an exact term", () => {
    expect(whereToQuery([clause({})])).toEqual({
      bool: { filter: [{ term: { email: { value: "a@example.com" } } }] },
    });
  });

  it("translates eq on numbers, booleans and dates to exact terms", () => {
    expect(
      whereToQuery([
        clause({ field: "count", value: 3 }),
        clause({ field: "emailVerified", value: false }),
        clause({ field: "createdAt", value: DATE }),
        clause({ field: "expiresAt", value: ISO }),
      ]),
    ).toEqual({
      bool: {
        filter: [
          { term: { count: { value: 3 } } },
          { term: { emailVerified: { value: false } } },
          { term: { createdAt: { value: ISO } } },
          { term: { expiresAt: { value: ISO } } },
        ],
      },
    });
  });

  it("matches null or missing fields for eq null", () => {
    expect(whereToQuery([clause({ field: "image", value: null })])).toEqual({
      bool: {
        filter: [{ bool: { must_not: [{ exists: { field: "image" } }] } }],
      },
    });
  });

  it("matches present, non-null fields for ne null", () => {
    expect(
      whereToQuery([clause({ field: "image", value: null, operator: "ne" })]),
    ).toEqual({ bool: { filter: [{ exists: { field: "image" } }] } });
  });

  it("translates ne on each value type to an excluded term", () => {
    const excluded = (field: string, value: unknown) => ({
      bool: { must_not: [{ term: { [field]: { value } } }] },
    });
    expect(
      whereToQuery([
        clause({ operator: "ne" }),
        clause({ field: "count", value: 3, operator: "ne" }),
        clause({ field: "emailVerified", value: true, operator: "ne" }),
        clause({ field: "createdAt", value: DATE, operator: "ne" }),
      ]),
    ).toEqual({
      bool: {
        filter: [
          excluded("email", "a@example.com"),
          excluded("count", 3),
          excluded("emailVerified", true),
          excluded("createdAt", ISO),
        ],
      },
    });
  });

  it.each(["gt", "gte", "lt", "lte"] as const)(
    "translates %s on each value type to a range",
    (operator) => {
      const range = (field: string, value: unknown) => ({
        range: { [field]: { [operator]: value } },
      });
      expect(
        whereToQuery([
          clause({ field: "name", value: "m", operator }),
          clause({ field: "count", value: 3, operator }),
          clause({ field: "emailVerified", value: false, operator }),
          clause({ field: "createdAt", value: DATE, operator }),
        ]),
      ).toEqual({
        bool: {
          filter: [
            range("name", "m"),
            range("count", 3),
            range("emailVerified", false),
            range("createdAt", ISO),
          ],
        },
      });
    },
  );

  it("matches nothing when a range is compared with null", () => {
    expect(
      whereToQuery([clause({ field: "count", value: null, operator: "gt" })]),
    ).toEqual({ bool: { filter: [{ match_none: {} }] } });
  });

  it("translates in on each value type to a terms set", () => {
    expect(
      whereToQuery([
        clause({ field: "id", value: ["a", "b"], operator: "in" }),
        clause({ field: "count", value: [1, 2], operator: "in" }),
        clause({
          field: "emailVerified",
          // better-auth's type omits boolean[], but a caller can still send one.
          value: [true] as unknown as string[],
          operator: "in",
        }),
        clause({
          field: "createdAt",
          value: [DATE] as unknown as string[],
          operator: "in",
        }),
      ]),
    ).toEqual({
      bool: {
        filter: [
          { terms: { id: ["a", "b"] } },
          { terms: { count: [1, 2] } },
          { terms: { emailVerified: [true] } },
          { terms: { createdAt: [ISO] } },
        ],
      },
    });
  });

  it("translates not_in on each value type to an excluded terms set", () => {
    const excludedSet = (field: string, values: unknown[]) => ({
      bool: { must_not: [{ terms: { [field]: values } }] },
    });
    expect(
      whereToQuery([
        clause({ field: "id", value: ["a", "b"], operator: "not_in" }),
        clause({ field: "count", value: [1, 2], operator: "not_in" }),
        clause({
          field: "emailVerified",
          value: [false] as unknown as string[],
          operator: "not_in",
        }),
        clause({
          field: "createdAt",
          value: [DATE] as unknown as string[],
          operator: "not_in",
        }),
      ]),
    ).toEqual({
      bool: {
        filter: [
          excludedSet("id", ["a", "b"]),
          excludedSet("count", [1, 2]),
          excludedSet("emailVerified", [false]),
          excludedSet("createdAt", [ISO]),
        ],
      },
    });
  });

  it("treats an empty in as matching nothing and an empty not_in as matching everything", () => {
    expect(
      whereToQuery([
        clause({ field: "id", value: [], operator: "in" }),
        clause({ field: "id", value: [], operator: "not_in" }),
      ]),
    ).toEqual({
      bool: {
        filter: [
          { terms: { id: [] } },
          { bool: { must_not: [{ terms: { id: [] } }] } },
        ],
      },
    });
  });

  it.each([
    ["contains", (v: string) => `*${v}*`],
    ["starts_with", (v: string) => `${v}*`],
    ["ends_with", (v: string) => `*${v}`],
  ] as const)(
    "translates %s on a string to a case-sensitive wildcard",
    (operator, pattern) => {
      expect(
        whereToQuery([clause({ field: "name", value: "Ann", operator })]),
      ).toEqual({
        bool: { filter: [{ wildcard: { name: { value: pattern("Ann") } } }] },
      });
    },
  );

  // Elasticsearch rejects wildcard queries on number, boolean and date
  // fields, and a pattern cannot match those values anyway.
  it.each(["contains", "starts_with", "ends_with"] as const)(
    "matches nothing for %s on number, boolean and date values",
    (operator) => {
      expect(
        whereToQuery([
          clause({ field: "count", value: 3, operator }),
          clause({ field: "emailVerified", value: true, operator }),
          clause({ field: "createdAt", value: DATE, operator }),
        ]),
      ).toEqual({
        bool: {
          filter: [{ match_none: {} }, { match_none: {} }, { match_none: {} }],
        },
      });
    },
  );

  it("escapes wildcard characters in pattern values", () => {
    expect(
      whereToQuery([
        clause({ field: "name", value: "a*b?c\\d", operator: "contains" }),
      ]),
    ).toEqual({
      bool: {
        filter: [{ wildcard: { name: { value: "*a\\*b\\?c\\\\d*" } } }],
      },
    });
  });

  describe("connectors", () => {
    const a = clause({ field: "a", value: "1" });
    const b = clause({ field: "b", value: "2", connector: "OR" });
    const c = clause({ field: "c", value: "3" });
    const d = clause({ field: "d", value: "4", connector: "OR" });
    const term = (field: string, value: string) => ({
      term: { [field]: { value } },
    });

    it("requires every AND clause and at least one OR clause, whatever the order", () => {
      expect(whereToQuery([a, b, c, d])).toEqual({
        bool: {
          filter: [term("a", "1"), term("c", "3")],
          should: [term("b", "2"), term("d", "4")],
          minimum_should_match: 1,
        },
      });
    });

    it("requires at least one clause when every clause is OR", () => {
      expect(whereToQuery([b, d])).toEqual({
        bool: {
          should: [term("b", "2"), term("d", "4")],
          minimum_should_match: 1,
        },
      });
    });

    it("requires a lone OR clause", () => {
      expect(whereToQuery([b])).toEqual({
        bool: { should: [term("b", "2")], minimum_should_match: 1 },
      });
    });
  });

  it("ignores clause keys it does not know", () => {
    const withExtra = { ...clause({}), collate: "de", hint: 1 } as CleanedWhere;
    expect(whereToQuery([withExtra])).toEqual(whereToQuery([clause({})]));
  });

  describe("insensitive mode", () => {
    const insensitive = (overrides: Partial<CleanedWhere>) =>
      clause({ mode: "insensitive", ...overrides });
    const termCi = (field: string, value: string) => ({
      term: { [field]: { value, case_insensitive: true } },
    });

    it("compares eq and ne without regard to case", () => {
      expect(
        whereToQuery([
          insensitive({ value: "A@Example.com" }),
          insensitive({ value: "B@Example.com", operator: "ne" }),
        ]),
      ).toEqual({
        bool: {
          filter: [
            termCi("email", "A@Example.com"),
            { bool: { must_not: [termCi("email", "B@Example.com")] } },
          ],
        },
      });
    });

    it("compares each in and not_in value without regard to case", () => {
      const anyOf = {
        bool: {
          should: [termCi("email", "A@x.io"), termCi("email", "B@x.io")],
          minimum_should_match: 1,
        },
      };
      expect(
        whereToQuery([
          insensitive({ value: ["A@x.io", "B@x.io"], operator: "in" }),
          insensitive({ value: ["A@x.io", "B@x.io"], operator: "not_in" }),
        ]),
      ).toEqual({
        bool: { filter: [anyOf, { bool: { must_not: [anyOf] } }] },
      });
    });

    it.each([
      ["contains", "*Ann*"],
      ["starts_with", "Ann*"],
      ["ends_with", "*Ann"],
    ] as const)("matches %s without regard to case", (operator, value) => {
      expect(
        whereToQuery([insensitive({ field: "name", value: "Ann", operator })]),
      ).toEqual({
        bool: {
          filter: [{ wildcard: { name: { value, case_insensitive: true } } }],
        },
      });
    });

    it("leaves non-string values and empty sets as they are", () => {
      expect(
        whereToQuery([
          insensitive({ field: "count", value: 3 }),
          insensitive({ field: "emailVerified", value: true, operator: "ne" }),
          insensitive({ field: "count", value: [1, 2], operator: "in" }),
          insensitive({ field: "id", value: [], operator: "in" }),
          insensitive({ field: "image", value: null }),
        ]),
      ).toEqual({
        bool: {
          filter: [
            { term: { count: { value: 3 } } },
            {
              bool: {
                must_not: [{ term: { emailVerified: { value: true } } }],
              },
            },
            { terms: { count: [1, 2] } },
            { terms: { id: [] } },
            { bool: { must_not: [{ exists: { field: "image" } }] } },
          ],
        },
      });
    });
  });
});
