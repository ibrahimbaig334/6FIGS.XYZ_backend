/**
 * CORS origin helper: WEB_ORIGIN accepts one URL or a comma-separated list.
 *   WEB_ORIGIN=http://localhost:3000
 *   WEB_ORIGIN=https://6figs.xyz,https://www.6figs.xyz,http://localhost:3000
 * Empty/unset = open (reflect any origin). Trims whitespace and drops blanks
 * so "a.com, b.com" works. Auth rides on Bearer headers, not cookies, so a
 * reflected origin carries no ambient authority.
 */
export function corsOrigin(): string | string[] | true {
  const raw = (process.env.WEB_ORIGIN ?? "").trim();
  if (!raw) return true;
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (list.length === 0) return true;
  if (list.length === 1) return list[0];
  return list;
}
