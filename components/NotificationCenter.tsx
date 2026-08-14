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
        if (!res.ok) throw new Error('Failed to load notifications');

        const data = await res.json();
        setNotifications(data.data.notifications);
        setUnreadCount(data.data.unread_count);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load notifications');
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

  const typeNames: Record<string, string> = {
    ROSTER_GEREED: '📋 Roster Ready',
    TOEWIJZING: '📅 Assignment Made',
    RUILVERZOEK: '🔄 Swap Requested',
    RUIL_GOEDGEKEURD: '✓ Swap Approved',
    PUBLICATIE_BERICHT: '📢 Publication Notice',
  };

  const typeColors: Record<string, string> = {
    ROSTER_GEREED: 'text-blue-600 bg-blue-50',
    TOEWIJZING: 'text-green-600 bg-green-50',
    RUILVERZOEK: 'text-amber-600 bg-amber-50',
    RUIL_GOEDGEKEURD: 'text-green-600 bg-green-50',
    PUBLICATIE_BERICHT: 'text-purple-600 bg-purple-50',
  };

  if (loading) {
    return (
      <div className="card p-8 text-center">
        <p className="text-lg text-neutral-600">Loading notifications...</p>
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
          Unread: <span data-testid="unread-count">{unreadCount}</span>
        </span>

        <select
          name="notification-type"
          value={filterType}
          onChange={(e) => setFilterType(e.target.value)}
          className="px-3 py-2 border rounded text-sm"
        >
          <option value="">All types</option>
          <option value="ROSTER_GEREED">Roster Ready</option>
          <option value="TOEWIJZING">Assignment Made</option>
          <option value="RUILVERZOEK">Swap Requested</option>
          <option value="RUIL_GOEDGEKEURD">Swap Approved</option>
          <option value="PUBLICATIE_BERICHT">Publication Notice</option>
        </select>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={unreadOnly}
            onChange={(e) => setUnreadOnly(e.target.checked)}
            className="w-4 h-4"
          />
          Unread only
        </label>
      </div>

      {/* Notifications List */}
      <div className="space-y-3">
        {notifications.length === 0 && (
          <div className="card p-8 text-center">
            <p className="text-neutral-600">No notifications</p>
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
                  {new Date(notif.aangemaakt_op).toLocaleString()}
                </p>
              </div>

              {!notif.gelezen && (
                <button
                  onClick={() => handleMarkRead(notif.id)}
                  className="px-3 py-1 rounded text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors"
                >
                  Mark as read
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
