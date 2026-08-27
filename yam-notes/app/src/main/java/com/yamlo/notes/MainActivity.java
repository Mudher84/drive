package com.yamlo.notes;

import android.app.*;
import android.os.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.provider.Settings;
import android.webkit.*;
import android.widget.Toast;
import java.io.*;
import java.text.SimpleDateFormat;
import java.util.*;

public class MainActivity extends Activity {
    private WebView webView;
    private static final int EXPORT_REQ=7001, IMPORT_REQ=7002;
    private String pendingExport="";

    @Override public void onCreate(Bundle b){super.onCreate(b);getWindow().setStatusBarColor(Color.TRANSPARENT);getWindow().setNavigationBarColor(Color.WHITE);webView=new WebView(this);WebSettings s=webView.getSettings();s.setJavaScriptEnabled(true);s.setDomStorageEnabled(true);s.setAllowFileAccess(true);webView.setLayoutDirection(WebView.LAYOUT_DIRECTION_RTL);webView.addJavascriptInterface(new NativeBridge(),"YamNative");webView.setWebChromeClient(new WebChromeClient());webView.loadUrl("file:///android_asset/pro.html");setContentView(webView);}

    public class NativeBridge {
        @JavascriptInterface public void share(String title,String text){runOnUiThread(()->{Intent i=new Intent(Intent.ACTION_SEND);i.setType("text/plain");i.putExtra(Intent.EXTRA_SUBJECT,title);i.putExtra(Intent.EXTRA_TEXT,text);startActivity(Intent.createChooser(i,"مشاركة الملاحظة"));});}
        @JavascriptInterface public void copy(String text){runOnUiThread(()->{android.content.ClipboardManager c=(android.content.ClipboardManager)getSystemService(CLIPBOARD_SERVICE);c.setPrimaryClip(android.content.ClipData.newPlainText("Yam Notes",text));Toast.makeText(MainActivity.this,"تم النسخ",Toast.LENGTH_SHORT).show();});}
        @JavascriptInterface public void exportBackup(String json){pendingExport=json;runOnUiThread(()->{Intent i=new Intent(Intent.ACTION_CREATE_DOCUMENT);i.addCategory(Intent.CATEGORY_OPENABLE);i.setType("application/json");i.putExtra(Intent.EXTRA_TITLE,"Yam-Notes-Backup-"+new SimpleDateFormat("yyyyMMdd",Locale.US).format(new Date())+".json");startActivityForResult(i,EXPORT_REQ);});}
        @JavascriptInterface public void importBackup(){runOnUiThread(()->{Intent i=new Intent(Intent.ACTION_OPEN_DOCUMENT);i.addCategory(Intent.CATEGORY_OPENABLE);i.setType("application/json");startActivityForResult(i,IMPORT_REQ);});}
        @JavascriptInterface public void scheduleReminder(String id,String title,long when){runOnUiThread(()->{if(Build.VERSION.SDK_INT>=33&&checkSelfPermission("android.permission.POST_NOTIFICATIONS")!=PackageManager.PERMISSION_GRANTED)requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"},88);Intent i=new Intent(MainActivity.this,MainActivity.class);PendingIntent pi=PendingIntent.getActivity(MainActivity.this,id.hashCode(),i,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);AlarmManager am=(AlarmManager)getSystemService(ALARM_SERVICE);try{am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP,when,pi);Toast.makeText(MainActivity.this,"تم ضبط التذكير",Toast.LENGTH_SHORT).show();}catch(Exception e){Toast.makeText(MainActivity.this,"تعذر ضبط التذكير",Toast.LENGTH_SHORT).show();}});}
        @JavascriptInterface public void appSettings(){runOnUiThread(()->{Intent i=new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:"+getPackageName()));startActivity(i);});}
    }

    @Override protected void onActivityResult(int req,int result,Intent data){super.onActivityResult(req,result,data);if(result!=RESULT_OK||data==null)return;Uri u=data.getData();if(u==null)return;try{if(req==EXPORT_REQ){try(OutputStream o=getContentResolver().openOutputStream(u)){o.write(pendingExport.getBytes("UTF-8"));}Toast.makeText(this,"تم تصدير النسخة الاحتياطية",Toast.LENGTH_SHORT).show();}else if(req==IMPORT_REQ){StringBuilder x=new StringBuilder();try(BufferedReader r=new BufferedReader(new InputStreamReader(getContentResolver().openInputStream(u),"UTF-8"))){String l;while((l=r.readLine())!=null)x.append(l);}String js=JSONObjectQuote(x.toString());webView.evaluateJavascript("window.yamImportBackup("+js+")",null);}}catch(Exception e){Toast.makeText(this,"تعذر قراءة الملف",Toast.LENGTH_SHORT).show();}}
    private String JSONObjectQuote(String s){return "\""+s.replace("\\","\\\\").replace("\"","\\\"").replace("\n","\\n").replace("\r","\\r")+"\"";}
    @Override public void onBackPressed(){if(webView.canGoBack())webView.goBack();else super.onBackPressed();}
}
