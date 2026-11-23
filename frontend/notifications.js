(() => {
  const button = document.getElementById('notificationButton');
  const count = document.getElementById('notificationCount');
  const layer = document.getElementById('modalLayer');
  const heading = document.getElementById('modalHeading');
  const form = document.getElementById('modalForm');
  const notifications = { items: [], unreadCount: 0 };
  let panelOpen = false;

  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  }[character]));

  async function request(url, options = {}) {
    const token = sessionStorage.getItem('propertyflow-token');
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {})
      }
    });
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error('The server returned an invalid response.');
    }
    if (!response.ok) throw new Error(data.error || 'Unable to update notifications.');
    return data;
  }

  function renderPanel() {
    const readAll = notifications.unreadCount
      ? '<div class="notification-actions"><button type="button" class="link-button" onclick="markAllNotificationsRead()">Mark all as read</button></div>'
      : '';
    const items = notifications.items.map(item => {
      const delivery = item.delivery || {};
      const emailStatus = delivery.email?.status || 'not sent';
      const smsStatus = delivery.sms?.status || 'not sent';
      const createdAt = new Date(item.createdAt);
      const timestamp = Number.isNaN(createdAt.getTime())
        ? ''
        : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(createdAt);
      return `<article class="notification-item ${item.readAt ? '' : 'unread'}"><div class="name">${escapeHtml(item.subject)}</div><p>${escapeHtml(item.text)}</p><div class="notification-meta"><span>${escapeHtml(timestamp)} · Email ${escapeHtml(emailStatus)} · SMS ${escapeHtml(smsStatus)}</span>${item.readAt ? '' : `<button type="button" onclick="markNotificationRead('${escapeHtml(item.id)}')">Mark read</button>`}</div></article>`;
    }).join('') || '<div class="notification-empty">You’re all caught up. New account, payment, and maintenance updates will appear here.</div>';
    form.onsubmit = null;
    form.innerHTML = `${readAll}<div class="notification-list" aria-live="polite">${items}</div>`;
  }

  async function refresh(silent = false) {
    if (!sessionStorage.getItem('propertyflow-token')) return;
    try {
      const result = await request('/api/notifications?limit=50');
      notifications.items = result.notifications || [];
      notifications.unreadCount = result.unreadCount || 0;
      count.textContent = notifications.unreadCount > 99 ? '99+' : String(notifications.unreadCount);
      count.classList.toggle('hidden', notifications.unreadCount === 0);
      button.setAttribute('aria-label', `Notifications, ${notifications.unreadCount} unread`);
      if (panelOpen) renderPanel();
    } catch (error) {
      console.error('Could not refresh notifications:', error);
      if (!silent) window.showToast?.(error.message);
    }
  }

  window.openNotifications = async () => {
    panelOpen = true;
    heading.textContent = 'Notifications';
    form.innerHTML = '<div class="notification-empty">Loading notifications…</div>';
    form.onsubmit = null;
    layer.classList.add('open');
    await refresh(false);
    renderPanel();
  };

  window.markNotificationRead = async notificationId => {
    try {
      await request(`/api/notifications/${encodeURIComponent(notificationId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ read: true })
      });
      await refresh(true);
    } catch (error) {
      console.error('Could not mark notification as read:', error);
      window.showToast?.(error.message);
    }
  };

  window.markAllNotificationsRead = async () => {
    try {
      await request('/api/notifications/read-all', { method: 'PATCH' });
      await refresh(true);
    } catch (error) {
      console.error('Could not mark notifications as read:', error);
      window.showToast?.(error.message);
    }
  };

  new MutationObserver(() => {
    if (!layer.classList.contains('open')) panelOpen = false;
  }).observe(layer, { attributes: true, attributeFilter: ['class'] });

  new MutationObserver(() => {
    if (!document.getElementById('appScreen').classList.contains('hidden')) refresh(true);
  }).observe(document.getElementById('appScreen'), { attributes: true, attributeFilter: ['class'] });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh(true);
  });
  window.setInterval(() => refresh(true), 20_000);
  if (!document.getElementById('appScreen').classList.contains('hidden')) refresh(true);
})();
