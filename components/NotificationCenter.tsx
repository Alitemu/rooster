'use client';

/**
 * Notification Center Component
 *
 * Shows notifications for a person with filtering and read/dismiss capability.
 */

import { useState, useEffect } from 'react';

interface Notification {
  id: string;
  periode_id: string | null;
  type: string;
  onderwerp: string;
  inhoud: string;
  gelezen: boolean;
  aangemaakt_op: string;
}

interface Props {
  personId: string;
  periodId?: string;
}

export function NotificationCenter({ personId, periodId }: Props) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterType, setFilterType] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);

  useEffect(() => {
    const loadNotifications = async () => {
      setLoading(true);
      setError(null);

      try {
        let url = `/api/person/${personId}/notifications?limit=50`;
        if (periodId) url += `&period_id=${periodId}`;
        if (filterType) url += `&type=${filterType}`;
        if (unreadOnly) url += `&unread_only=true`;

        const res = await fetch(url);
        if (!res.ok) throw new Error('Laden van meldingen mislukt');

        const data = await res.json();
        setNotifications(data.data.notifications);
        setUnreadCount(data.data.unread_count);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Laden van meldingen mislukt');
      } finally {
        setLoading(false);
      }
    };

    loadNotifications();
  }, [personId, periodId, filterType, unreadOnly]);

  const handleMarkRead = async (notifId: string) => {
    try {
      const res = await fetch(`/api/person/${personId}/notifications/${notifId}/read`, {
        method: 'POST',
      });

      if (res.ok) {
        setNotifications(
          notifications.map((n) =>
            n.id === notifId ? { ...n, gelezen: true } : n
          )
        );
        setUnreadCount((count) => Math.max(0, count - 1));
      }
    } catch (err) {
      console.error('Failed to mark notification as read:', err);
    }
  };

  const handleDismiss = async (notifId: string) => {
    try {
      const res = await fetch(`/api/person/${personId}/notifications/${notifId}/dismiss`, {
        method: 'POST',
      });

      if (res.ok) {
        const dismissed = notifications.find((n) => n.id === notifId);
        setNotifications(notifications.filter((n) => n.id !== notifId));
        if (dismissed && !dismissed.gelezen) {
          setUnreadCount((count) => Math.max(0, count - 1));
        }
      }
    } catch (err) {
      console.error('Failed to dismiss notification:', err);
    }
  };

  const typeNames: Record<string, string> = {
    ROSTER_GEREED: '📋 Rooster gereed',
    TOEWIJZING: '📅 Toewijzing gemaakt',
    RUILVERZOEK: '🔄 Ruilverzoek',
    RUIL_GOEDGEKEURD: '✓ Ruil goedgekeurd',
    RUIL_AFGEWEZEN: '✗ Ruil geweigerd',
    PUBLICATIE_BERICHT: '📢 Publicatiebericht',
    BLOCK_OVERRIDDEN: '⚠ Voorkeur overschreven',
  };

  const typeColors: Record<string, string> = {
    ROSTER_GEREED: 'text-blue-600 bg-blue-50',
    TOEWIJZING: 'text-green-600 bg-green-50',
    RUILVERZOEK: 'text-amber-600 bg-amber-50',
    RUIL_GOEDGEKEURD: 'text-green-600 bg-green-50',
    RUIL_AFGEWEZEN: 'text-red-600 bg-red-50',
    PUBLICATIE_BERICHT: 'text-purple-600 bg-purple-50',
    BLOCK_OVERRIDDEN: 'text-amber-600 bg-amber-50',
  };

  if (loading) {
    return (
      <div className="card p-8 text-center">
        <p className="text-lg text-neutral-600">Meldingen laden...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card p-8 bg-red-50 border border-red-200">
        <p className="text-red-700">{error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="card p-4 bg-neutral-50 flex gap-4 items-center flex-wrap">
        <span className="text-sm font-medium text-neutral-700">
          Ongelezen: <span data-testid="unread-count">{unreadCount}</span>
        </span>

        <select
          name="notification-type"
          value={filterType}
          onChange={(e) => setFilterType(e.target.value)}
          className="px-3 py-2 border rounded text-sm"
        >
          <option value="">Alle types</option>
          <option value="ROSTER_GEREED">Rooster gereed</option>
          <option value="TOEWIJZING">Toewijzing gemaakt</option>
          <option value="RUILVERZOEK">Ruilverzoek</option>
          <option value="RUIL_GOEDGEKEURD">Ruil goedgekeurd</option>
          <option value="PUBLICATIE_BERICHT">Publicatiebericht</option>
        </select>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={unreadOnly}
            onChange={(e) => setUnreadOnly(e.target.checked)}
            className="w-4 h-4"
          />
          Alleen ongelezen
        </label>
      </div>

      {/* Notifications List */}
      <div className="space-y-3">
        {notifications.length === 0 && (
          <div className="card p-8 text-center">
            <p className="text-neutral-600">Geen meldingen</p>
          </div>
        )}

        {notifications.map((notif) => (
          <div
            key={notif.id}
            data-testid="notification-item"
            data-type={notif.type}
            className={`card p-4 border-l-4 ${
              notif.gelezen
                ? 'border-neutral-200 bg-neutral-50'
                : 'border-blue-600 bg-blue-50'
            }`}
          >
            <div className="flex gap-4 justify-between items-start">
              <div className="flex-1">
                <div className="flex items-start gap-2 mb-2">
                  <span
                    className={`inline-block px-2 py-1 rounded text-xs font-medium ${
                      typeColors[notif.type] || 'text-neutral-600 bg-neutral-100'
                    }`}
                  >
                    {typeNames[notif.type] || notif.type}
                  </span>
                  {!notif.gelezen && (
                    <span
                      data-unread="true"
                      className="inline-block w-2 h-2 rounded-full bg-blue-600 mt-1"
                    />
                  )}
                </div>
                <h3 className="font-semibold text-neutral-900">{notif.onderwerp}</h3>
                <p className="text-sm text-neutral-700 mt-1">{notif.inhoud}</p>
                <p className="text-xs text-neutral-500 mt-2">
                  {new Date(notif.aangemaakt_op).toLocaleString('nl-NL')}
                </p>
              </div>

              <div className="flex flex-col gap-2 items-end">
                {!notif.gelezen && (
                  <button
                    onClick={() => handleMarkRead(notif.id)}
                    className="px-3 py-1 rounded text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors"
                  >
                    Markeer als gelezen
                  </button>
                )}
                <button
                  onClick={() => handleDismiss(notif.id)}
                  className="px-3 py-1 rounded text-sm font-medium bg-neutral-200 text-neutral-700 hover:bg-neutral-300 transition-colors"
                >
                  Verbergen
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
