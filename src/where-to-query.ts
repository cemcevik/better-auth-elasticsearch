import type { CleanedWhere } from "better-auth/adapters";

/** An Elasticsearch query DSL object. */
export type EsQuery = Record<string, unknown>;

type Value = CleanedWhere["value"];

/** Dates are stored as ISO strings, so they are compared as ISO strings. */
const toStoredValue = (value: Value) =>
  value instanceof Date ? value.toISOString() : value;

const not = (query: EsQuery): EsQuery => ({ bool: { must_not: [query] } });

/** Only string comparisons have a case; the flag is dropped for the rest. */
const caseFlag = (value: unknown, insensitive: boolean) =>
  insensitive && typeof value === "string" ? { case_insensitive: true } : {};

const equals = (field: string, value: Value, insensitive: boolean): EsQuery =>
  value === null
    ? not({ exists: { field } })
    : {
        term: {
          [field]: {
            value: toStoredValue(value),
            ...caseFlag(value, insensitive),
          },
        },
      };

const oneOf = (field: string, value: Value, insensitive: boolean): EsQuery => {
  const values = (Array.isArray(value) ? value : [value]) as Value[];
  // The terms query has no case-insensitive form, so each value gets a term.
  if (
    insensitive &&
    values.length > 0 &&
    values.every((v) => typeof v === "string")
  ) {
    return {
      bool: {
        should: values.map((v) => equals(field, v, true)),
        minimum_should_match: 1,
      },
    };
  }
  return { terms: { [field]: values.map(toStoredValue) } };
};

const escapeWildcard = (value: string) =>
  value.replace(/[\\*?]/g, (token) => `\\${token}`);

const PATTERNS = {
  contains: (v: string) => `*${v}*`,
  starts_with: (v: string) => `${v}*`,
  ends_with: (v: string) => `*${v}`,
} as const;

const matchesPattern = (
  field: string,
  value: Value,
  pattern: keyof typeof PATTERNS,
  insensitive: boolean,
): EsQuery =>
  // Only strings have patterns; Elasticsearch also rejects wildcard queries
  // on number, boolean and date fields.
  typeof value !== "string"
    ? { match_none: {} }
    : {
        wildcard: {
          [field]: {
            value: PATTERNS[pattern](escapeWildcard(value)),
            ...caseFlag(value, insensitive),
          },
        },
      };

const clauseToQuery = ({
  field,
  value,
  operator,
  mode,
}: CleanedWhere): EsQuery => {
  const insensitive = mode === "insensitive";
  switch (operator) {
    case "contains":
    case "starts_with":
    case "ends_with":
      return matchesPattern(field, value, operator, insensitive);
    case "in":
      return oneOf(field, value, insensitive);
    case "not_in":
      return not(oneOf(field, value, insensitive));
    case "ne":
      return value === null
        ? { exists: { field } }
        : not(equals(field, value, insensitive));
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      // Nothing orders against null; an unbounded range would match everything.
      return value === null
        ? { match_none: {} }
        : { range: { [field]: { [operator]: toStoredValue(value) } } };
    default:
      return equals(field, value, insensitive);
  }
};

/**
 * Translates better-auth where clauses into an Elasticsearch query.
 * Field names must already be the stored field names.
 */
export const whereToQuery = (where: CleanedWhere[]): EsQuery => {
  if (where.length === 0) return { match_all: {} };
  // As in better-auth's first-party adapters: every AND clause must match,
  // and so must at least one OR clause, wherever the clauses appear.
  const and = where.filter((w) => w.connector !== "OR").map(clauseToQuery);
  const or = where.filter((w) => w.connector === "OR").map(clauseToQuery);
  return {
    bool: {
      ...(and.length > 0 ? { filter: and } : {}),
      ...(or.length > 0 ? { should: or, minimum_should_match: 1 } : {}),
    },
  };
};
