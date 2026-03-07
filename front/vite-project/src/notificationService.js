const NOTIFICATIONS_KEY = 'stock_transfer_notifications';
const NOTIFICATIONS_CHANNEL = 'stock_transfer_notifications_channel';

let notificationsChannel = null;

const getNotificationsChannel = () => {
  if (typeof window === 'undefined' || !('BroadcastChannel' in window)) {
    return null;
  }

  if (!notificationsChannel) {
    notificationsChannel = new BroadcastChannel(NOTIFICATIONS_CHANNEL);
  }

  return notificationsChannel;
};

const publishRealtimeUpdate = (type, detail) => {
  window.dispatchEvent(new CustomEvent(type, { detail }));

  const channel = getNotificationsChannel();
  if (channel) {
    channel.postMessage({ type, detail });
  }
};

export const notificationService = {
  getNotifications: () => {
    try {
      const data = localStorage.getItem(NOTIFICATIONS_KEY);
      return data ? JSON.parse(data) : [];
    } catch (e) {
      console.error('Error reading notifications:', e);
      return [];
    }
  },

  addNotification: (storeId, storeName, productId, productName, reason) => {
    try {
      const notifications = notificationService.getNotifications();
      const newNotification = {
        id: Date.now(),
        storeId,
        storeName,
        productId,
        productName,
        reason, 
        timestamp: new Date().toISOString(),
        read: false,
      };
      notifications.push(newNotification);
      localStorage.setItem(NOTIFICATIONS_KEY, JSON.stringify(notifications));

      publishRealtimeUpdate('notificationAdded', newNotification);
      
      return newNotification;
    } catch (e) {
      console.error('Error adding notification:', e);
    }
  },

  deleteNotification: (notificationId) => {
    try {
      const notifications = notificationService.getNotifications();
      const filtered = notifications.filter(n => n.id !== notificationId);
      localStorage.setItem(NOTIFICATIONS_KEY, JSON.stringify(filtered));

      publishRealtimeUpdate('notificationDeleted', { id: notificationId });
    } catch (e) {
      console.error('Error deleting notification:', e);
    }
  },

  clearAll: () => {
    try {
      localStorage.removeItem(NOTIFICATIONS_KEY);
      publishRealtimeUpdate('notificationsCleared');
    } catch (e) {
      console.error('Error clearing notifications:', e);
    }
  },
};
