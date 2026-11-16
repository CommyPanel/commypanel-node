import { InvalidInputError } from "./errors.js";

/** App names ("slugs") are lower case letters, digits and hyphens. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** Variable names follow the shell's rule. */
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export function checkSlug(slug: unknown): asserts slug is string {
  if (typeof slug !== "string" || !SLUG.test(slug)) {
    throw new InvalidInputError();
  }
}

export function checkEnvKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || !ENV_KEY.test(key)) {
    throw new InvalidInputError();
  }
}

export function checkNumber(number: unknown): asserts number is number {
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1) {
    throw new InvalidInputError();
  }
}
