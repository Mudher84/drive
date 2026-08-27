package com.yamlo.notes;

import android.app.*;
import android.os.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.provider.Settings;
import android.provider.OpenableColumns;
import android.database.Cursor;
import android.webkit.*;
import android.widget.Toast;
import android.media.MediaRecorder;
import android.util.Base64;
import org.json.JSONObject;
import java.io.*;
import java.text.SimpleDateFormat;
import java.util.*;

public class MainActivity extends Activity {
    private WebView webView;
    private static final int EXPORT_REQ=7001, IMPORT_REQ=7002, ATTACH_REQ=7003, CREDENTIAL_REQ=7004, AUDIO_PERMISSION=7005;
    private String pendingExport="";
    private MediaRecorder recorder;
    private File audioFile;

    @Override public void onCreate(Bundle b){
        super.onCreate(b);
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.WHITE);
        webView=new WebView(this);
        WebSettings s=webView.getSettings();
        s.setJavaScriptEnabled(true);s.setDomStorageEnabled(true);s.setAllowFileAccess(true);s.setAllowContentAccess(true);
        webView.setLayoutDirection(WebView.LAYOUT_DIRECTION_RTL);
        webView.addJavascriptInterface(new NativeBridge(),"YamNative");
        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient(){@Override public void onPageFinished(WebView v,String url){super.onPageFinished(v,url);injectNativeUi();}});
        webView.loadUrl("file:///android_asset/pro.html");
        setContentView(webView);
    }

    private void injectNativeUi(){
        String js="(function(){if(window.__yamNativeV4)return;window.__yamNativeV4=true;"+
        "window.yamImportBackup=function(x){try{var d=JSON.parse(x);if(d.notes)localStorage.setItem('yam.notes.pro.v3',JSON.stringify(d.notes));if(d.settings)localStorage.setItem('yam.notes.settings.v3',JSON.stringify(d.settings));location.reload();}catch(e){alert('ملف النسخة الاحتياطية غير صالح')}};"+
        "window.yamAttachmentAdded=function(n,d){try{var b=document.getElementById('body');if(b)b.value+=(b.value?'\\n':'')+'📎 مرفق: '+n;var a=JSON.parse(localStorage.getItem('yam.attachments.v4')||'[]');a.push({name:n,data:d,time:Date.now()});localStorage.setItem('yam.attachments.v4',JSON.stringify(a));}catch(e){}};"+
        "window.yamAudioReady=function(n,d){try{var b=document.getElementById('body');if(b)b.value+=(b.value?'\\n':'')+'🎙 تسجيل صوتي: '+n;var a=JSON.parse(localStorage.getItem('yam.audio.v4')||'[]');a.push({name:n,data:d,time:Date.now()});localStorage.setItem('yam.audio.v4',JSON.stringify(a));}catch(e){}};"+
        "var tools=document.querySelector('.tools');if(tools){var at=document.createElement('button');at.className='tool';at.textContent='📎 مرفق';at.onclick=function(){YamNative.pickAttachment()};tools.appendChild(at);var au=document.createElement('button');au.className='tool';au.id='yamAudio';au.textContent='🎙 تسجيل';au.dataset.rec='0';au.onclick=function(){if(au.dataset.rec==='0'){var r=YamNative.startRecording();if(r==='ok'){au.dataset.rec='1';au.textContent='■ إيقاف'}}else{YamNative.stopRecording();au.dataset.rec='0';au.textContent='🎙 تسجيل'}};tools.appendChild(au);}"+
        "var sh=document.getElementById('share');if(sh)sh.onclick=function(){YamNative.share(document.getElementById('title').value,document.getElementById('body').value)};"+
        "var cp=document.getElementById('copy');if(cp)cp.onclick=function(){YamNative.copy(document.getElementById('title').value+'\\n'+document.getElementById('body').value)};"+
        "var dr=document.querySelector('.drawerbox');if(dr){var bk=document.createElement('button');bk.className='ditem';bk.textContent='☁ تصدير نسخة احتياطية';bk.onclick=function(){var notes=JSON.parse(localStorage.getItem('yam.notes.pro.v3')||'[]');var settings=JSON.parse(localStorage.getItem('yam.notes.settings.v3')||'{}');YamNative.exportBackup(JSON.stringify({version:4,notes:notes,settings:settings,exportedAt:Date.now()}))};dr.appendChild(bk);var im=document.createElement('button');im.className='ditem';im.textContent='↥ استعادة نسخة احتياطية';im.onclick=function(){YamNative.importBackup()};dr.appendChild(im);var sec=document.createElement('button');sec.className='ditem';sec.textContent='🔐 قفل بأمان الجهاز';sec.onclick=function(){YamNative.deviceUnlock()};dr.appendChild(sec);}"+
        "})();";
        webView.evaluateJavascript(js,null);
    }

    public class NativeBridge {
        @JavascriptInterface public void share(String title,String text){runOnUiThread(()->{Intent i=new Intent(Intent.ACTION_SEND);i.setType("text/plain");i.putExtra(Intent.EXTRA_SUBJECT,title);i.putExtra(Intent.EXTRA_TEXT,text);startActivity(Intent.createChooser(i,"مشاركة الملاحظة"));});}
        @JavascriptInterface public void copy(String text){runOnUiThread(()->{android.content.ClipboardManager c=(android.content.ClipboardManager)getSystemService(CLIPBOARD_SERVICE);c.setPrimaryClip(android.content.ClipData.newPlainText("Yam Notes",text));Toast.makeText(MainActivity.this,"تم النسخ",Toast.LENGTH_SHORT).show();});}
        @JavascriptInterface public void exportBackup(String json){pendingExport=json;runOnUiThread(()->{Intent i=new Intent(Intent.ACTION_CREATE_DOCUMENT);i.addCategory(Intent.CATEGORY_OPENABLE);i.setType("application/json");i.putExtra(Intent.EXTRA_TITLE,"Yam-Notes-Backup-"+new SimpleDateFormat("yyyyMMdd-HHmm",Locale.US).format(new Date())+".json");startActivityForResult(i,EXPORT_REQ);});}
        @JavascriptInterface public void importBackup(){runOnUiThread(()->{Intent i=new Intent(Intent.ACTION_OPEN_DOCUMENT);i.addCategory(Intent.CATEGORY_OPENABLE);i.setType("application/json");startActivityForResult(i,IMPORT_REQ);});}
        @JavascriptInterface public void pickAttachment(){runOnUiThread(()->{Intent i=new Intent(Intent.ACTION_OPEN_DOCUMENT);i.addCategory(Intent.CATEGORY_OPENABLE);i.setType("*/*");startActivityForResult(i,ATTACH_REQ);});}
        @JavascriptInterface public String startRecording(){if(Build.VERSION.SDK_INT>=23&&checkSelfPermission("android.permission.RECORD_AUDIO")!=PackageManager.PERMISSION_GRANTED){runOnUiThread(()->requestPermissions(new String[]{"android.permission.RECORD_AUDIO"},AUDIO_PERMISSION));return "permission";}try{audioFile=new File(getCacheDir(),"yam-audio-"+System.currentTimeMillis()+".m4a");recorder=new MediaRecorder();recorder.setAudioSource(MediaRecorder.AudioSource.MIC);recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);recorder.setAudioEncodingBitRate(128000);recorder.setAudioSamplingRate(44100);recorder.setOutputFile(audioFile.getAbsolutePath());recorder.prepare();recorder.start();return "ok";}catch(Exception e){return "error";}}
        @JavascriptInterface public void stopRecording(){try{if(recorder!=null){recorder.stop();recorder.release();recorder=null;}if(audioFile!=null&&audioFile.exists()){byte[] data=readAll(new FileInputStream(audioFile),6*1024*1024);String b64=Base64.encodeToString(data,Base64.NO_WRAP);String name=audioFile.getName();runOnUiThread(()->webView.evaluateJavascript("window.yamAudioReady("+JSONObject.quote(name)+","+JSONObject.quote("data:audio/mp4;base64,"+b64)+")",null));}}catch(Exception e){runOnUiThread(()->Toast.makeText(MainActivity.this,"تعذر حفظ التسجيل",Toast.LENGTH_SHORT).show());}}
        @JavascriptInterface public void scheduleReminder(String id,String title,String text,long when){runOnUiThread(()->{if(Build.VERSION.SDK_INT>=33&&checkSelfPermission("android.permission.POST_NOTIFICATIONS")!=PackageManager.PERMISSION_GRANTED)requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"},88);Intent i=new Intent(MainActivity.this,ReminderReceiver.class);i.putExtra("title",title);i.putExtra("text",text);PendingIntent pi=PendingIntent.getBroadcast(MainActivity.this,id.hashCode(),i,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);AlarmManager am=(AlarmManager)getSystemService(ALARM_SERVICE);try{am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP,when,pi);Toast.makeText(MainActivity.this,"تم ضبط التذكير",Toast.LENGTH_SHORT).show();}catch(Exception e){Toast.makeText(MainActivity.this,"تعذر ضبط التذكير",Toast.LENGTH_SHORT).show();}});}
        @JavascriptInterface public void deviceUnlock(){runOnUiThread(()->{KeyguardManager km=(KeyguardManager)getSystemService(KEYGUARD_SERVICE);if(Build.VERSION.SDK_INT>=21&&km.isDeviceSecure()){Intent i=km.createConfirmDeviceCredentialIntent("Yam Notes Pro","أكد هويتك لفتح الملاحظات");if(i!=null)startActivityForResult(i,CREDENTIAL_REQ);}else Toast.makeText(MainActivity.this,"فعّل قفل الجهاز أولاً",Toast.LENGTH_LONG).show();});}
        @JavascriptInterface public void appSettings(){runOnUiThread(()->startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,Uri.parse("package:"+getPackageName()))));}
    }

    @Override protected void onActivityResult(int req,int result,Intent data){super.onActivityResult(req,result,data);if(req==CREDENTIAL_REQ){if(result==RESULT_OK)Toast.makeText(this,"تم التحقق بنجاح",Toast.LENGTH_SHORT).show();return;}if(result!=RESULT_OK||data==null)return;Uri u=data.getData();if(u==null)return;try{if(req==EXPORT_REQ){try(OutputStream o=getContentResolver().openOutputStream(u)){o.write(pendingExport.getBytes("UTF-8"));}Toast.makeText(this,"تم تصدير النسخة الاحتياطية",Toast.LENGTH_SHORT).show();}else if(req==IMPORT_REQ){String x=new String(readAll(getContentResolver().openInputStream(u),10*1024*1024),"UTF-8");webView.evaluateJavascript("window.yamImportBackup("+JSONObject.quote(x)+")",null);}else if(req==ATTACH_REQ){String name=fileName(u);String mime=getContentResolver().getType(u);if(mime==null)mime="application/octet-stream";byte[] d=readAll(getContentResolver().openInputStream(u),8*1024*1024);String uri="data:"+mime+";base64,"+Base64.encodeToString(d,Base64.NO_WRAP);webView.evaluateJavascript("window.yamAttachmentAdded("+JSONObject.quote(name)+","+JSONObject.quote(uri)+")",null);}}catch(Exception e){Toast.makeText(this,"تعذر معالجة الملف",Toast.LENGTH_SHORT).show();}}
    private String fileName(Uri u){String n="مرفق";Cursor c=getContentResolver().query(u,null,null,null,null);if(c!=null){try{int i=c.getColumnIndex(OpenableColumns.DISPLAY_NAME);if(i>=0&&c.moveToFirst())n=c.getString(i);}finally{c.close();}}return n;}
    private byte[] readAll(InputStream in,int max)throws IOException{ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] b=new byte[8192];int n,total=0;while((n=in.read(b))!=-1){total+=n;if(total>max)throw new IOException("too large");out.write(b,0,n);}in.close();return out.toByteArray();}
    @Override public void onBackPressed(){if(webView.canGoBack())webView.goBack();else super.onBackPressed();}
    @Override protected void onDestroy(){try{if(recorder!=null){recorder.release();recorder=null;}}catch(Exception ignored){}super.onDestroy();}
}
