import { ImageResponse } from 'next/og';

/**
 * Browser-tab icon.
 *
 * Generated rather than a static image file: this project has no public/
 * directory at all (see .dockerignore's comment on why that stays true -
 * nothing meant to be baked into a build artifact belongs there), and a
 * generated icon needs no binary asset to keep in the repo or regenerate
 * when the brand colour changes.
 *
 * A calendar grid with a checkmark - the roster and the "filled in, done"
 * state the whole app is built around (a slot is either open or someone
 * has confirmed it). primary-600 (#0284c7, tailwind.config.ts) so the tab
 * icon and the app's own header bar read as the same product.
 */

export const size = { width: 32, height: 32 };
export const contentType = 'image/png';

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: '#0284c7',
          borderRadius: 7,
        }}
      >
        {/* Header strip, like a calendar's month bar. */}
        <div style={{ display: 'flex', height: 9, background: '#075985' }} />
        {/* Grid of days. */}
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexWrap: 'wrap',
            alignContent: 'flex-start',
            padding: '3px 4px',
            gap: 2,
          }}
        >
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              style={{
                width: 5,
                height: 5,
                borderRadius: 1,
                background: i === 4 ? '#ffffff' : 'rgba(255,255,255,0.55)',
              }}
            />
          ))}
        </div>
      </div>
    ),
    { ...size }
  );
}
