// Credential redaction, shared by every path that prints a URL back to the user.
//
// It lives here rather than in new.mjs because `doctor` needs it too: the probe
// echoes fetch's own error message, and that message embeds the URL verbatim —
// userinfo included. Two paths of the same binary were hardened differently,
// which is how the leak survived (the scaffold redacted, the doctor did not).

/**
 * Replace the userinfo portion of a URL with ***, leaving everything else.
 *
 * The character class is `[^/\s]*` — NOT `[^/@\s]+`. A password may legally
 * contain `@` (percent-encoding it is optional and people rarely do it), and the
 * old class stopped at the FIRST one: `https://user:p@ssw0rd@host/r` redacted to
 * `https://***@ssw0rd@host/r`, printing the tail of the password into exactly
 * the CI log this function exists to keep it out of. Greedy up to the LAST `@`
 * before the path is the correct boundary — that is where the URL grammar puts
 * the end of userinfo.
 *
 * Credentials also travel in the query string, which the userinfo rule cannot
 * see, so those are cleared by name.
 */
export function redactUrlCredentials(url) {
  return String(url)
    .replace(/\/\/[^/\s]*@/, '//***@')
    .replace(/([?&](?:token|access_token|api_key|apikey|password|secret)=)[^&\s]+/gi, '$1***');
}
