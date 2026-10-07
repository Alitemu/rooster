/**
 * The export dialog's reminder text is one editable text for everyone: the
 * first person's, with their codenaam and their personal link in it. Each
 * recipient gets that text with both swapped for their own. Swapping only
 * the link sent everyone "Beste Persoon-01".
 *
 * The codenaam is replaced only as a whole word, so the first person being
 * Persoon-1 never turns Persoon-10 in the text into someone else.
 */

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function personaliseReminder(
  tekst: string,
  template: { codenaam: string; link: string },
  ontvanger: { codenaam: string; link: string }
): string {
  const withLink = template.link ? tekst.split(template.link).join(ontvanger.link) : tekst;
  if (!template.codenaam) return withLink;
  const wholeWord = new RegExp(`(?<![\\p{L}\\p{N}_-])${escapeRegExp(template.codenaam)}(?![\\p{L}\\p{N}_-])`, 'gu');
  return withLink.replace(wholeWord, () => ontvanger.codenaam);
}
