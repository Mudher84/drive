package com.yamlo.notes;

import android.app.*;
import android.content.*;
import android.os.Build;

public class ReminderReceiver extends BroadcastReceiver {
    public static final String CHANNEL_ID = "yam_notes_reminders";
    @Override public void onReceive(Context context, Intent intent) {
        String title = intent.getStringExtra("title");
        String text = intent.getStringExtra("text");
        if (title == null || title.trim().isEmpty()) title = "تذكير Yam Notes";
        if (text == null) text = "عندك ملاحظة تحتاج انتباهك";
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "تذكيرات Yam Notes", NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription("إشعارات التذكيرات الخاصة بالملاحظات");
            nm.createNotificationChannel(ch);
        }
        Intent open = new Intent(context, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(context, CHANNEL_ID) : new Notification.Builder(context);
        b.setSmallIcon(com.yamlo.notes.R.drawable.ic_yam_launcher)
         .setContentTitle(title)
         .setContentText(text)
         .setStyle(new Notification.BigTextStyle().bigText(text))
         .setContentIntent(pi)
         .setAutoCancel(true)
         .setPriority(Notification.PRIORITY_HIGH);
        nm.notify((int)(System.currentTimeMillis() & 0x7fffffff), b.build());
    }
}
