/**
 * A streefbereik in words, the way every screen and mail says it (CLAUDE.md: never "2-3" or "[2,3]"):
 * "2 of 3 avonddiensten", "hoogstens 1 weekenddienst", "geen feestdagdiensten".
 *
 * Here since 2.1.0 so the invitation and the participant's page say what the planner's page says. They named
 * the top of the range as "ongeveer 3 avonddiensten" and "ongeveer 1 feestdagdienst": in a period with 60
 * avonddiensten and one feestdagdienst for 30 people, all 30 got 2 avonddiensten and 29 no feestdagdienst,
 * and read their roster as less than promised (audit per role 2.0.2, R2-01).
 */
export function bereikInWoorden(min: number, max: number, enkel: string, meervoud: string): string {
  const woord = (n: number) => (n === 1 ? enkel : meervoud);
  if (max <= 0) return `geen ${meervoud}`;
  if (min <= 0) return `hoogstens ${max} ${woord(max)}`;
  if (min === max) return `${max} ${woord(max)}`;
  return max - min === 1 ? `${min} of ${max} ${meervoud}` : `${min} tot en met ${max} ${meervoud}`;
}
