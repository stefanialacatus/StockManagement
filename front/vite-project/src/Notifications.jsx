import React, { useState, useEffect } from 'react';
import { notificationService } from './notificationService';

const NOTIFICATIONS_KEY = 'stock_transfer_notifications';
const NOTIFICATIONS_CHANNEL = 'stock_transfer_notifications_channel';

const Notifications = () => {
  const [notifications, setNotifications] = useState([]);

  useEffect(() => {
    let channel = null;

    const initialNotifications = notificationService.getNotifications();
    setNotifications(initialNotifications);

    const handleNotificationAdded = (event) => {
      setNotifications(prev => [...prev, event.detail]);
    };

    const handleNotificationDeleted = (event) => {
      setNotifications(prev => prev.filter(n => n.id !== event.detail.id));
    };

    const handleNotificationsCleared = () => {
      setNotifications([]);
    };

    const handleStorageChange = (event) => {
      if (event.key === NOTIFICATIONS_KEY) {
        setNotifications(notificationService.getNotifications());
      }
    };

    const handleChannelMessage = () => {
      setNotifications(notificationService.getNotifications());
    };

    if ('BroadcastChannel' in window) {
      channel = new BroadcastChannel(NOTIFICATIONS_CHANNEL);
      channel.addEventListener('message', handleChannelMessage);
    }

    window.addEventListener('notificationAdded', handleNotificationAdded);
    window.addEventListener('notificationDeleted', handleNotificationDeleted);
    window.addEventListener('notificationsCleared', handleNotificationsCleared);
    window.addEventListener('storage', handleStorageChange);

    return () => {
      window.removeEventListener('notificationAdded', handleNotificationAdded);
      window.removeEventListener('notificationDeleted', handleNotificationDeleted);
      window.removeEventListener('notificationsCleared', handleNotificationsCleared);
      window.removeEventListener('storage', handleStorageChange);

      if (channel) {
        channel.removeEventListener('message', handleChannelMessage);
        channel.close();
      }
    };
  }, []);

  const handleDismiss = (notificationId) => {
    notificationService.deleteNotification(notificationId);
  };

  if (notifications.length === 0) {
    return null;
  }

  return (
    <div className="notifications-container">
      <div className="notifications-header">
        <h4>📬 Transfer Requests ({notifications.length})</h4>
      </div>
      <div className="notifications-list">
        {notifications.map(notification => (
          <div key={notification.id} className="notification-item">
            <div className="notification-content">
              <p className="notification-title">
                <strong>{notification.storeName}</strong>
              </p>
              <p className="notification-message">
                Product: <strong>{notification.productName}</strong> - Status: <strong>{notification.reason === 'understock' ? '🔴 UNDERSTOCK' : '🟠 AT RISK'}</strong>
              </p>
              <p className="notification-time">
                {new Date(notification.timestamp).toLocaleString()}
              </p>
            </div>
            <button
              className="notification-dismiss"
              onClick={() => handleDismiss(notification.id)}
              title="Dismiss notification"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};

export default Notifications;
