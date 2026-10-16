/**
 * What a feestdag means for the AIOS's marks, in a box of its own on the
 * preferences screen and with the absences: blocking is not possible
 * there, also not for a block with a feestdag in it, and an absence on a
 * feestdag is "liever niet" (lib/aiosPreferences.ts). It was one sentence
 * among the rest and was asked to stand out (October 2026). A border and the
 * star, so it also reads in black and white.
 */

export function AiosFeestdagUitleg() {
  return (
    <div className="rounded border-2 border-neutral-800 bg-white p-3 text-sm text-neutral-900 space-y-1">
      <p className="font-semibold">★ Let op bij feestdagen</p>
      <ul className="list-disc pl-5 space-y-0.5">
        <li>Een dienst op een feestdag kun je niet blokkeren. Liever niet kan wel.</li>
        <li>Valt er een feestdag in een avond- of nachtblok, dan kun je dat hele blok niet blokkeren.</li>
        <li>
          Ben je afwezig op een feestdag, dan telt die dag als liever niet. Je kunt op die feestdag dus toch
          ingepland worden.
        </li>
      </ul>
      <p className="text-neutral-700">Dat is omdat de feestdagen eerlijk over alle AIOS worden verdeeld.</p>
    </div>
  );
}
