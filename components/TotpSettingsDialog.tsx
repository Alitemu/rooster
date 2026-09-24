'use client';

/**
 * Turn your own account's two-step verification on or off.
 *
 * The server side of this (generate a secret, confirm a live code, verify
 * one at login) has existed since Phase 0 - CLAUDE.md has always described
 * "QR code shown at setup" as part of this app's authentication. No screen
 * ever called any of it: a planner had no way to enroll, and once enrolled
 * (the only way in was a direct API call) there was no way to turn it back
 * off either, so a lost authenticator app would have permanently locked
 * that account out of password-only login.
 */

import { useState, useEffect, useCallback } from 'react';
import { useBodyScrollLock } from '@/lib/useBodyScrollLock';
import { useDialogDismiss } from '@/lib/useDialogDismiss';
import { withBasePath } from '@/lib/basePath';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

type Status = 'loading' | 'enrolled' | 'not-enrolled';

export function TotpSettingsDialog({ isOpen, onClose }: Props) {
  const [status, setStatus] = useState<Status>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);

  // Enrollment (not-enrolled -> enrolled)
  const [qrCodeImage, setQrCodeImage] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [setupToken, setSetupToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [enrolling, setEnrolling] = useState(false);
  const [enrollError, setEnrollError] = useState<string | null>(null);
  const [justEnrolled, setJustEnrolled] = useState(false);

  // Disabling (enrolled -> not-enrolled)
  const [disablePassword, setDisablePassword] = useState('');
  const [disabling, setDisabling] = useState(false);
  const [disableError, setDisableError] = useState<string | null>(null);
  const [justDisabled, setJustDisabled] = useState(false);

  useBodyScrollLock(isOpen);
  const handleBackdropClick = useDialogDismiss(isOpen, onClose, !enrolling && !disabling);

  const reset = useCallback(() => {
    setStatus('loading');
    setLoadError(null);
    setQrCodeImage(null);
    setSecret(null);
    setSetupToken(null);
    setCode('');
    setEnrollError(null);
    setJustEnrolled(false);
    setDisablePassword('');
    setDisableError(null);
    setJustDisabled(false);
  }, []);

  // Fetch current status fresh every time the dialog opens, rather than
  // trusting stale state from a previous open - another tab or a previous
  // session in this same browser could have changed it since.
  useEffect(() => {
    if (!isOpen) return;
    reset();
    fetch(withBasePath('/api/auth/me'))
      .then((res) => res.json())
      .then((data) => {
        if (!data?.data?.authenticated) {
          setLoadError('Sessie niet gevonden. Log opnieuw in.');
          return;
        }
        setStatus(data.data.totp_enrolled ? 'enrolled' : 'not-enrolled');
      })
      .catch(() => setLoadError('Status ophalen is mislukt'));
  }, [isOpen, reset]);

  if (!isOpen) return null;

  const close = () => {
    reset();
    onClose();
  };

  const beginEnroll = async () => {
    setEnrollError(null);
    setEnrolling(true);
    try {
      const res = await fetch(withBasePath('/api/auth/totp/setup'), { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        setEnrollError(data?.error?.message ?? 'Starten van instellen is mislukt');
        return;
      }
      setQrCodeImage(data.data.qr_code_image);
      setSecret(data.data.secret);
      setSetupToken(data.data.setup_token);
    } catch {
      setEnrollError('Starten van instellen is mislukt');
    } finally {
      setEnrolling(false);
    }
  };

  const confirmEnroll = async () => {
    if (!setupToken) return;
    setEnrollError(null);
    setEnrolling(true);
    try {
      const res = await fetch(withBasePath('/api/auth/totp/confirm'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ setup_token: setupToken, code }),
      });
      const data = await res.json();
      if (!res.ok) {
        setEnrollError(data?.error?.message ?? 'Bevestigen is mislukt');
        return;
      }
      setJustEnrolled(true);
      setStatus('enrolled');
      setQrCodeImage(null);
      setSecret(null);
      setSetupToken(null);
      setCode('');
    } catch {
      setEnrollError('Bevestigen is mislukt');
    } finally {
      setEnrolling(false);
    }
  };

  const disable = async () => {
    setDisableError(null);
    setDisabling(true);
    try {
      const res = await fetch(withBasePath('/api/auth/totp/disable'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wachtwoord: disablePassword }),
      });
      const data = await res.json();
      if (!res.ok) {
        setDisableError(data?.error?.message ?? 'Uitschakelen is mislukt');
        return;
      }
      setJustDisabled(true);
      setStatus('not-enrolled');
      setDisablePassword('');
    } catch {
      setDisableError('Uitschakelen is mislukt');
    } finally {
      setDisabling(false);
    }
  };

  return (
    <div
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-label="Tweestapsverificatie"
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
    >
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full max-h-full flex flex-col">
        <div className="border-b p-6 flex-shrink-0">
          <h2 className="text-xl font-bold">Tweestapsverificatie</h2>
          <p className="text-sm text-neutral-600 mt-1">
            Een extra code uit een authenticator-app, naast je wachtwoord.
          </p>
        </div>

        <div className="p-6 space-y-4 overflow-y-auto min-h-0">
          {status === 'loading' && !loadError && (
            <p className="text-sm text-neutral-600">Status ophalen...</p>
          )}

          {loadError && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">{loadError}</div>
          )}

          {status === 'not-enrolled' && !justEnrolled && (
            <>
              {!setupToken ? (
                <>
                  <p className="text-sm text-neutral-700">
                    Tweestapsverificatie staat uit. Bij het instellen scan je een QR-code met je
                    authenticator-app (bijv. Google Authenticator of Authy) en bevestig je met een
                    code.
                  </p>
                  {enrollError && (
                    <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
                      {enrollError}
                    </div>
                  )}
                </>
              ) : (
                <>
                  {qrCodeImage && (
                    <div className="flex justify-center">
                      {/* eslint-disable-next-line @next/next/no-img-element -- a
                          data: URL generated server-side, not a remote/optimizable image */}
                      <img src={qrCodeImage} alt="QR-code voor tweestapsverificatie" width={200} height={200} />
                    </div>
                  )}
                  <div>
                    <p className="text-xs text-neutral-600 mb-1">
                      Kun je de QR-code niet scannen? Vul deze sleutel handmatig in:
                    </p>
                    <code className="block text-xs bg-neutral-100 rounded p-2 break-all">{secret}</code>
                  </div>
                  <div>
                    <label htmlFor="totp-code" className="block text-sm font-semibold text-neutral-900 mb-2">
                      Code uit de app
                    </label>
                    <input
                      id="totp-code"
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      value={code}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                      className="w-full px-3 py-2 border rounded-lg text-sm tracking-widest"
                      placeholder="123456"
                    />
                  </div>
                  {enrollError && (
                    <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
                      {enrollError}
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {justEnrolled && (
            <div className="rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-900">
              <p className="font-semibold">Tweestapsverificatie is ingeschakeld.</p>
              <p className="mt-1">Vanaf nu vraagt inloggen ook om een code uit je authenticator-app.</p>
            </div>
          )}

          {status === 'enrolled' && !justDisabled && (
            <>
              <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-900">
                Tweestapsverificatie is ingeschakeld voor dit account.
              </div>
              <div>
                <label htmlFor="totp-disable-wachtwoord" className="block text-sm font-semibold text-neutral-900 mb-2">
                  Wachtwoord (om uit te schakelen)
                </label>
                <input
                  id="totp-disable-wachtwoord"
                  type="password"
                  autoComplete="current-password"
                  value={disablePassword}
                  onChange={(e) => setDisablePassword(e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg text-sm"
                />
                <p className="text-xs text-neutral-500 mt-1">
                  Ben je je authenticator-app kwijt? Dan zet je het hier uit. Daarvoor is
                  alleen je wachtwoord nodig.
                </p>
              </div>
              {disableError && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
                  {disableError}
                </div>
              )}
            </>
          )}

          {justDisabled && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              <p className="font-semibold">Tweestapsverificatie is uitgeschakeld.</p>
              <p className="mt-1">Inloggen vraagt vanaf nu weer alleen om je wachtwoord.</p>
            </div>
          )}
        </div>

        <div className="border-t p-6 flex-shrink-0 flex justify-end gap-3">
          <button onClick={close} disabled={enrolling || disabling} className="btn-secondary">
            {justEnrolled || justDisabled ? 'Sluiten' : 'Annuleren'}
          </button>

          {status === 'not-enrolled' && !justEnrolled && !setupToken && (
            <button onClick={beginEnroll} disabled={enrolling} className="btn-primary">
              {enrolling ? 'Bezig...' : 'Instellen'}
            </button>
          )}
          {status === 'not-enrolled' && !justEnrolled && setupToken && (
            <button onClick={confirmEnroll} disabled={enrolling || code.length !== 6} className="btn-primary">
              {enrolling ? 'Bezig...' : 'Bevestigen'}
            </button>
          )}
          {status === 'enrolled' && !justDisabled && (
            <button
              onClick={disable}
              disabled={disabling || disablePassword.length === 0}
              className="px-4 py-2 rounded font-medium bg-red-600 text-white hover:bg-red-700 disabled:bg-neutral-400 transition-colors"
            >
              {disabling ? 'Bezig...' : 'Uitschakelen'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
