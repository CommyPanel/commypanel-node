/**
 * Removes the token (plain and URL-encoded) from text that is about to become part of an error. Used for
 * transport errors and for error text the panel sent back. Not part of the public API.
 * @internal
 */
export function redact(text: string, token: string): string {
  if (token === "") {
    return text;
  }
  return text.split(token).join("[redacted]").split(encodeURIComponent(token)).join("[redacted]");
}
