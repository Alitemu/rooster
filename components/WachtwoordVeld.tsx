'use client';

/**
 * A password field that can show what was typed, and says when Caps Lock is on (0.904.0). A backup password saved as
 * "wachtwoordwachtwoord" was typed back as "Wachtwoordwachtwoord" and the restore said only that it did not match:
 * dots hide a capital letter as well as a missing one.
 *
 * autoComplete="new-password" also on a field for an existing password: a browser fills its saved login into a
 * field with "off", which on the restore was the planner's own password in front of what they typed.
 */

import { useState, type KeyboardEvent } from 'react';

export function WachtwoordVeld({
  id,
  value,
  onChange,
  placeholder,
  beschrijving,
}: {
  id: string;
  value: string;
  onChange: (waarde: string) => void;
  placeholder?: string;
  /** The id of a text that says more about the field (aria-describedby). */
  beschrijving?: string;
}) {
  const [zichtbaar, setZichtbaar] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const kijk = (e: KeyboardEvent<HTMLInputElement>) => setCapsLock(e.getModifierState('CapsLock'));
  const capsId = `${id}-capslock`;
  return (
    <div>
      <div className="flex gap-2">
        <input
          id={id}
          type={zichtbaar ? 'text' : 'password'}
          autoComplete="new-password"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={kijk}
          onKeyUp={kijk}
          onBlur={() => setCapsLock(false)}
          aria-describedby={[beschrijving, capsLock ? capsId : null].filter(Boolean).join(' ') || undefined}
          className="min-w-0 flex-1 px-3 py-2 border rounded-lg text-sm"
        />
        <button
          type="button"
          onClick={() => setZichtbaar((z) => !z)}
          aria-controls={id}
          className="shrink-0 px-3 py-2 rounded-lg border border-neutral-300 text-sm text-neutral-800 hover:bg-neutral-100"
        >
          {zichtbaar ? 'Verberg wachtwoord' : 'Toon wachtwoord'}
        </button>
      </div>
      {capsLock && (
        <p id={capsId} role="status" className="text-xs font-medium text-amber-900 mt-1">
          Caps Lock staat aan. Let op hoofdletters en kleine letters.
        </p>
      )}
    </div>
  );
}
