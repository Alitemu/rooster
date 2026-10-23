/**
 * A count with its noun in the right number: "1 dienst", "2 diensten",
 * "0 diensten". A message that counts goes through here, so that no screen
 * says "1 diensten" or "1 dag(en)".
 */
export function telwoord(n: number, enkelvoud: string, meervoud: string): string {
  return `${n} ${n === 1 ? enkelvoud : meervoud}`;
}
