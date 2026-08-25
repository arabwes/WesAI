self.addEventListener('push', function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (error) { data = { title: 'Shibam Coffee', body: event.data ? event.data.text() : 'Your schedule has an update.' }; }
  event.waitUntil(self.registration.showNotification(data.title || 'Shibam Coffee', {
    body: data.body || 'Your team portal has an update.',
    icon: data.icon || '/images/team-icon.svg',
    badge: data.badge || '/images/team-icon.svg',
    data: { url: data.url || '/team/schedule.html' }
  }));
});
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (windows) {
    var target = new URL(event.notification.data.url || '/team/schedule.html', self.location.origin).href;
    for (var index = 0; index < windows.length; index += 1) { if ('focus' in windows[index]) { windows[index].navigate(target); return windows[index].focus(); } }
    return clients.openWindow ? clients.openWindow(target) : undefined;
  }));
});
