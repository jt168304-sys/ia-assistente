package com.iaassistente.app;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.annotation.NonNull;

import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class MainActivity extends Activity implements TextToSpeech.OnInitListener {

    private static final int REQ_FILE = 1002;
    private static final int REQ_REC_AUDIO = 1003;

    private WebView webView;
    private TextToSpeech tts;
    private TextRecognizer textRecognizer;
    private SpeechRecognizer speechRecognizer;
    private ValueCallback<Uri[]> filePathCallback;
    private String voiceLang = "pt-BR";
    private boolean ttsReady = false;
    private volatile boolean ttsBusy = false; // atualizado pelos callbacks do TTS
    private boolean voiceWanted = false; // mãos-livres ativo (reabrir ao conceder permissão)
    private volatile boolean suppressVoiceCb = false; // ignora callbacks durante o release
    private String cachedConfig = null;
    private final Map<String, String[]> searchCache = new ConcurrentHashMap<>();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        tts = new TextToSpeech(this, this);
        textRecognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);

        webView = new WebView(this);
        webView.setBackgroundColor(0xFF05070E);
        setContentView(webView);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowFileAccessFromFileURLs(true);
        s.setAllowUniversalAccessFromFileURLs(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        if (Build.VERSION.SDK_INT >= 19) {
            WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        }

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                if (url.startsWith("file://") || url.startsWith("https://") || url.startsWith("http://")) {
                    return false;
                }
                return true;
            }

            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                if (failingUrl != null && failingUrl.startsWith("file:///android_asset/index.html")) {
                    view.loadData(
                            "<html><body style='background:#05070e;color:#e7ecff;font-family:sans-serif;"
                                    + "padding:40px;text-align:center'>"
                                    + "<h2>Não foi possível carregar a interface</h2>"
                                    + "<p style='color:#8fa0c9'>Reinstale o app ou reporte o erro.</p></body></html>",
                            "text/html", "utf-8");
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback,
                                             FileChooserParams fileChooserParams) {
                if (MainActivity.this.filePathCallback != null) {
                    MainActivity.this.filePathCallback.onReceiveValue(null);
                }
                MainActivity.this.filePathCallback = filePathCallback;
                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.setType("image/*");
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                startActivityForResult(Intent.createChooser(intent, "Selecionar imagem"), REQ_FILE);
                return true;
            }
        });

        webView.addJavascriptInterface(new AndroidBridge(), "AndroidBridge");
        webView.loadUrl("file:///android_asset/index.html");
    }

    /* ---------------- JS bridge ---------------- */
    private class AndroidBridge {
        @JavascriptInterface
        public String getConfig() {
            if (cachedConfig == null) {
                cachedConfig = readConfigJson();
            }
            return cachedConfig;
        }

        @JavascriptInterface
        public void speak(final String text) {
            runOnUiThread(() -> {
                if (ttsReady && text != null && !text.isEmpty()) {
                    tts.speak(text, TextToSpeech.QUEUE_ADD, null, "utt-" + System.currentTimeMillis());
                }
            });
        }

        @JavascriptInterface
        public void stopSpeak() {
            runOnUiThread(() -> {
                if (tts != null) {
                    tts.stop();
                    ttsBusy = false;
                }
            });
        }

        @JavascriptInterface
        public void setRate(final float rate) {
            runOnUiThread(() -> {
                if (ttsReady) tts.setSpeechRate(rate);
            });
        }

        @JavascriptInterface
        public void setLang(final String lang) {
            if (lang != null && lang.length() >= 2) {
                voiceLang = lang;
            }
        }

        /* Mãos-livres: liga a escuta contínua (SpeechRecognizer, sem o dialog do
         * Google). O fim da fala (pausa ~2-3s) é reportado via onVoiceFinal. */
        @JavascriptInterface
        public void startVoice() {
            runOnUiThread(() -> {
                voiceWanted = true;
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_REC_AUDIO);
                    return;
                }
                startContinuousListening();
            });
        }

        @JavascriptInterface
        public void stopVoice() {
            runOnUiThread(() -> {
                voiceWanted = false;
                cancelListening();
            });
        }

        @JavascriptInterface
        public boolean isSpeaking() {
            return ttsBusy;
        }

        @JavascriptInterface
        public void ocrBase64(final String dataUrl, final String token) {
            if (dataUrl == null || !dataUrl.contains(",")) {
                jsCallback("onOcrResult", "\"" + token + "\", \"\"");
                return;
            }
            final String b64 = dataUrl.substring(dataUrl.indexOf(',') + 1);
            new Thread(() -> {
                try {
                    byte[] bytes = android.util.Base64.decode(b64, android.util.Base64.DEFAULT);
                    Bitmap bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
                    if (bmp == null) {
                        jsCallback("onOcrResult", "\"" + token + "\", \"\"");
                        return;
                    }
                    int maxDim = 1600;
                    if (Math.max(bmp.getWidth(), bmp.getHeight()) > maxDim) {
                        float scale = (float) maxDim / Math.max(bmp.getWidth(), bmp.getHeight());
                        bmp = Bitmap.createScaledBitmap(bmp,
                                Math.round(bmp.getWidth() * scale),
                                Math.round(bmp.getHeight() * scale), true);
                    }
                    final Bitmap finalBmp = bmp;
                    InputImage image = InputImage.fromBitmap(finalBmp, 0);
                    textRecognizer.process(image)
                            .addOnSuccessListener(result -> {
                                String text = result.getText();
                                jsCallback("onOcrResult", "\"" + token + "\", " + JSONObject.quote(text));
                            })
                            .addOnFailureListener(e ->
                                    jsCallback("onOcrResult", "\"" + token + "\", \"\""));
                } catch (Exception e) {
                    jsCallback("onOcrResult", "\"" + token + "\", \"\"");
                }
            }).start();
        }

        @JavascriptInterface
        public void saveFile(final String filename, final String content) {
            new Thread(() -> {
                String path = saveTextFile(filename, content);
                runOnUiThread(() -> {
                    if (path != null) {
                        Toast.makeText(MainActivity.this, "Arquivo salvo: " + path, Toast.LENGTH_LONG).show();
                    } else {
                        Toast.makeText(MainActivity.this, "Falha ao salvar arquivo", Toast.LENGTH_SHORT).show();
                    }
                });
            }).start();
        }

        /* Pesquisa na web gratuita (DuckDuckGo) — sem chave e sem cartão.
         * Versão ASSÍNCRONA: roda em thread própria e devolve o resultado via
         * callback JS (onWebSearchResult), para não travar o thread de JS do
         * WebView durante o download. Resultado: array JSON
         * [{"title","url","snippet"}, ...]. */
        @JavascriptInterface
        public void webSearchAsync(final String query, final String token) {
            new Thread(() -> {
                String json;
                try {
                    json = webSearchNow(query);
                } catch (Exception e) {
                    json = "[]";
                }
                jsCallback("onWebSearchResult", "\"" + token + "\", " + json);
            }).start();
        }
    }

    private String webSearchNow(String query) {
        if (query == null || query.trim().isEmpty()) return "[]";
        String q = query.trim();
        long now = System.currentTimeMillis();
        String[] cached = searchCache.get(q);
        if (cached != null && now - Long.parseLong(cached[1]) < 10 * 60 * 1000L) {
            return cached[0];
        }
        try {
            List<Map<String, String>> results = new ArrayList<>();
            try {
                results.addAll(parseSearchJson(ddgSearch(q)));
            } catch (Exception ignored) {
            }
            if (results.size() < 3) {
                try {
                    Set<String> seen = new HashSet<>();
                    for (Map<String, String> r : results) seen.add(r.get("url"));
                    for (Map<String, String> w : parseSearchJson(wikipediaSearch(q))) {
                        String u = w.get("url");
                        if (u != null && !u.isEmpty() && !seen.contains(u) && results.size() < 5) {
                            results.add(w);
                            seen.add(u);
                        }
                    }
                } catch (Exception ignored) {
                }
            }
            String json = toSearchJson(results);
            searchCache.put(q, new String[]{json, String.valueOf(now)});
            return json;
        } catch (Exception e) {
            return "[]";
        }
    }

    /* DuckDuckGo: tenta GET (menos bloqueado) e cai para POST se vier vazio. */
    private String ddgSearch(String query) throws Exception {
        String json;
        try {
            json = ddgHtml(query, true);
        } catch (Exception ignored) {
            json = "[]";
        }
        if (json == null || json.trim().isEmpty() || "[]".equals(json.trim())) {
            try {
                json = ddgHtml(query, false);
            } catch (Exception ignored) {
                json = "[]";
            }
        }
        return json == null ? "[]" : json;
    }

    private String ddgHtml(String query, boolean useGet) throws Exception {
        HttpURLConnection conn;
        if (useGet) {
            String urlStr = "https://html.duckduckgo.com/html/?q=" + URLEncoder.encode(query, "UTF-8");
            conn = (HttpURLConnection) new URL(urlStr).openConnection();
            conn.setRequestMethod("GET");
        } else {
            String body = "q=" + URLEncoder.encode(query, "UTF-8") + "&b=&l=br-pt";
            conn = (HttpURLConnection) new URL("https://html.duckduckgo.com/html/").openConnection();
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
            conn.getOutputStream().write(body.getBytes("UTF-8"));
        }
        conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 10; SM-G975F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36");
        conn.setRequestProperty("Accept", "text/html,application/xhtml+xml,*/*;q=0.8");
        conn.setRequestProperty("Accept-Language", "pt-BR,pt;q=0.9");
        conn.setConnectTimeout(6000);
        conn.setReadTimeout(6000);
        String html = readConnection(conn);
        return parseDdgHtml(html);
    }

    private String parseDdgHtml(String html) {
        if (html == null) return "[]";
        try {
            Pattern linkPat = Pattern.compile(
                    "<a[^>]*class=\"result__a\"[^>]*href=\"([^\"]*)\"[^>]*>(.*?)</a>",
                    Pattern.DOTALL);
            Pattern snipPat = Pattern.compile(
                    "<a[^>]*class=\"result__snippet\"[^>]*>(.*?)</a>",
                    Pattern.DOTALL);
            Matcher lm = linkPat.matcher(html);
            Matcher sm = snipPat.matcher(html);
            StringBuilder out = new StringBuilder("[");
            int count = 0;
            while (lm.find() && count < 5) {
                String title = stripHtml(lm.group(2));
                String href = decodeDdgUrl(lm.group(1));
                String snippet = "";
                if (sm.find()) snippet = stripHtml(sm.group(1));
                if (count > 0) out.append(",");
                out.append("{\"title\":").append(jsonString(title))
                   .append(",\"url\":").append(jsonString(href))
                   .append(",\"snippet\":").append(jsonString(snippet)).append("}");
                count++;
            }
            out.append("]");
            return out.toString();
        } catch (Exception e) {
            return "[]";
        }
    }

    /* Wikipedia (pt): confiável sem chave, usado quando o DuckDuckGo falha.
     * Retorna o mesmo formato [{"title","url","snippet"}] do DDG. */
    private String wikipediaSearch(String query) throws Exception {
        String urlStr = "https://pt.wikipedia.org/w/api.php?action=query&list=search&srsearch="
                + URLEncoder.encode(query, "UTF-8") + "&srlimit=5&format=json";
        HttpURLConnection conn = (HttpURLConnection) new URL(urlStr).openConnection();
        conn.setRequestMethod("GET");
        conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 10; SM-G975F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36");
        conn.setRequestProperty("Accept", "application/json");
        conn.setConnectTimeout(6000);
        conn.setReadTimeout(6000);
        String body = readConnection(conn);
        JSONObject root = new JSONObject(body);
        JSONArray search = root.optJSONObject("query").optJSONArray("search");
        StringBuilder out = new StringBuilder("[");
        if (search != null) {
            for (int i = 0; i < search.length(); i++) {
                JSONObject r = search.getJSONObject(i);
                String title = r.optString("title", "");
                String snippet = stripHtml(r.optString("snippet", ""));
                String url = "https://pt.wikipedia.org/wiki/"
                        + URLEncoder.encode(title.replace(' ', '_'), "UTF-8");
                if (i > 0) out.append(",");
                out.append("{\"title\":").append(jsonString(title))
                   .append(",\"url\":").append(jsonString(url))
                   .append(",\"snippet\":").append(jsonString(snippet)).append("}");
            }
        }
        out.append("]");
        return out.toString();
    }

    private List<Map<String, String>> parseSearchJson(String json) {
        List<Map<String, String>> list = new ArrayList<>();
        if (json == null || json.trim().isEmpty()) return list;
        try {
            JSONArray arr = new JSONArray(json);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                Map<String, String> m = new LinkedHashMap<>();
                m.put("title", o.optString("title", ""));
                m.put("url", o.optString("url", ""));
                m.put("snippet", o.optString("snippet", ""));
                list.add(m);
            }
        } catch (Exception ignored) {
        }
        return list;
    }

    private String toSearchJson(List<Map<String, String>> results) {
        StringBuilder out = new StringBuilder("[");
        for (int i = 0; i < results.size(); i++) {
            Map<String, String> r = results.get(i);
            if (i > 0) out.append(",");
            out.append("{\"title\":").append(jsonString(r.get("title")))
               .append(",\"url\":").append(jsonString(r.get("url")))
               .append(",\"snippet\":").append(jsonString(r.get("snippet"))).append("}");
        }
        out.append("]");
        return out.toString();
    }

    private String readConnection(HttpURLConnection conn) throws Exception {
        int code = conn.getResponseCode();
        InputStream is = (code >= 200 && code < 300) ? conn.getInputStream() : conn.getErrorStream();
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        if (is != null) {
            while ((n = is.read(buf)) != -1) bos.write(buf, 0, n);
            is.close();
        }
        conn.disconnect();
        return bos.toString("UTF-8");
    }

    private String decodeDdgUrl(String href) {
        if (href == null) return "";
        try {
            if (href.contains("uddg=")) {
                String uddg = href.substring(href.indexOf("uddg=") + 5);
                int amp = uddg.indexOf('&');
                if (amp >= 0) uddg = uddg.substring(0, amp);
                return URLDecoder.decode(uddg, "UTF-8");
            }
            if (href.startsWith("//")) return "https:" + href;
        } catch (Exception ignored) {
        }
        return href;
    }

    private String stripHtml(String s) {
        if (s == null) return "";
        String t = s.replaceAll("<[^>]+>", "")
                .replace("&amp;", "&").replace("&quot;", "\"").replace("&#x27;", "'")
                .replace("&#39;", "'").replace("&lt;", "<").replace("&gt;", ">")
                .replace("&nbsp;", " ").replace("&ldquo;", "\u201c").replace("&rdquo;", "\u201d");
        return t.trim();
    }

    private String jsonString(String s) {
        if (s == null) return "\"\"";
        String t = s.replace("\\", "\\\\").replace("\"", "\\\"")
                .replace("\n", "\\n").replace("\r", "\\r");
        return "\"" + t + "\"";
    }

    /* ---------------- helpers ---------------- */
    private String readConfigJson() {
        try {
            InputStream is = getAssets().open("config.json");
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = is.read(buf)) != -1) {
                bos.write(buf, 0, n);
            }
            is.close();
            return bos.toString("UTF-8");
        } catch (Exception e) {
            return "{}";
        }
    }

    private String saveTextFile(String filename, String content) {
        String safeName = sanitizeFilename(filename);
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                android.content.ContentValues values = new android.content.ContentValues();
                values.put(MediaStore.MediaColumns.DISPLAY_NAME, safeName);
                values.put(MediaStore.MediaColumns.MIME_TYPE, "text/plain");
                values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/IAAssistente");
                Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) return null;
                try (FileOutputStream fos = (FileOutputStream) getContentResolver().openOutputStream(uri)) {
                    if (fos != null) fos.write(content.getBytes("UTF-8"));
                }
                return "Downloads/IAAssistente/" + safeName;
            } else {
                File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "IAAssistente");
                if (!dir.exists()) dir.mkdirs();
                File f = new File(dir, safeName);
                try (FileOutputStream fos = new FileOutputStream(f)) {
                    fos.write(content.getBytes("UTF-8"));
                }
                return f.getAbsolutePath();
            }
        } catch (Exception e) {
            return null;
        }
    }

    private String sanitizeFilename(String name) {
        if (name == null) return "arquivo.txt";
        String safe = name.replaceAll("[^A-Za-z0-9._-]", "_");
        if (safe.length() > 80) safe = safe.substring(safe.length() - 80);
        if (safe.isEmpty()) safe = "arquivo.txt";
        return safe;
    }

    /* ---------- Escuta contínua (SpeechRecognizer, sem dialog do Google) ----------
     * Quem decide quando (re)começar a escuta é o JS; aqui só iniciamos uma sessão,
     * reportamos parcial/final/erro e liberamos o microfone. A pausa de ~2,5s no fim
     * da fala faz o reconhecedor entregar o resultado (onResults). */
    private void startContinuousListening() {
        if (!voiceWanted) return;
        releaseRecognizer();
        try {
            SpeechRecognizer sr = SpeechRecognizer.createSpeechRecognizer(this);
            if (sr == null) {
                voiceWanted = false;
                jsCallback("onVoiceError", "\"Reconhecimento de voz indisponível neste aparelho\"");
                return;
            }
            speechRecognizer = sr;
            sr.setRecognitionListener(voiceListener);
            suppressVoiceCb = false;
            Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, voiceLang);
            intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
            intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 2500L);
            intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 1200L);
            intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3);
            sr.startListening(intent);
        } catch (SecurityException se) {
            jsCallback("onVoiceError", "\"sem-permissao\"");
        } catch (Exception e) {
            String msg = e.getMessage() == null ? "Erro ao iniciar microfone" : e.getMessage();
            jsCallback("onVoiceError", JSONObject.quote(msg));
        }
    }

    private final RecognitionListener voiceListener = new RecognitionListener() {
        @Override
        public void onReadyForSpeech(Bundle params) {
        }

        @Override
        public void onBeginningOfSpeech() {
        }

        @Override
        public void onRmsChanged(float rmsdB) {
        }

        @Override
        public void onBufferReceived(byte[] buffer) {
        }

        @Override
        public void onEndOfSpeech() {
        }

        @Override
        public void onError(int error) {
            if (suppressVoiceCb) return;
            jsCallback("onVoiceError", JSONObject.quote(speechErrorText(error)));
            releaseRecognizer();
        }

        @Override
        public void onResults(Bundle results) {
            if (suppressVoiceCb) return;
            ArrayList<String> list = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
            String text = (list != null && !list.isEmpty()) ? list.get(0) : "";
            jsCallback("onVoiceFinal", JSONObject.quote(text == null ? "" : text));
            releaseRecognizer();
        }

        @Override
        public void onPartialResults(Bundle partialResults) {
            if (suppressVoiceCb) return;
            ArrayList<String> list = partialResults.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
            String text = (list != null && !list.isEmpty()) ? list.get(0) : "";
            jsCallback("onVoicePartial", JSONObject.quote(text == null ? "" : text));
        }

        @Override
        public void onEvent(int eventType, Bundle params) {
        }
    };

    private static String speechErrorText(int e) {
        switch (e) {
            case SpeechRecognizer.ERROR_AUDIO:
                return "Erro de áudio";
            case SpeechRecognizer.ERROR_CLIENT:
                return "Reconhecimento ocupado";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                return "sem-permissao";
            case SpeechRecognizer.ERROR_NETWORK:
                return "Sem rede para reconhecer a fala";
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
                return "Tempo esgotado na rede";
            case SpeechRecognizer.ERROR_NO_MATCH:
                return "Não entendi";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
                return "Reconhecimento ocupado";
            case SpeechRecognizer.ERROR_SERVER:
                return "Serviço de reconhecimento indisponível";
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                return "Nada foi falado";
            default:
                return "Erro no microfone";
        }
    }

    /* Libera o microfone/recursos da sessão atual (se existir). */
    private void releaseRecognizer() {
        runOnUiThread(() -> {
            suppressVoiceCb = true;
            if (speechRecognizer != null) {
                try {
                    speechRecognizer.cancel();
                } catch (Exception ignored) {
                }
                try {
                    speechRecognizer.destroy();
                } catch (Exception ignored) {
                }
                speechRecognizer = null;
            }
        });
    }

    private void cancelListening() {
        voiceWanted = false;
        releaseRecognizer();
    }

    private void jsCallback(final String fn, final String args) {
        runOnUiThread(() -> {
            if (webView != null) {
                webView.evaluateJavascript("window." + fn + "(" + args + ");", null);
            }
        });
    }

    @Override
    public void onInit(int status) {
        if (status == TextToSpeech.SUCCESS) {
            Locale locale = new Locale("pt", "BR");
            if (tts.isLanguageAvailable(locale) >= TextToSpeech.LANG_AVAILABLE) {
                tts.setLanguage(locale);
            }
            tts.setSpeechRate(1.0f);
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override
                public void onStart(String utteranceId) {
                    ttsBusy = true;
                }

                @Override
                public void onDone(String utteranceId) {
                    try {
                        if (!tts.isSpeaking()) ttsBusy = false;
                    } catch (Exception ignored) {
                        ttsBusy = false;
                    }
                }

                @Override
                public void onError(String utteranceId) {
                    try {
                        if (!tts.isSpeaking()) ttsBusy = false;
                    } catch (Exception ignored) {
                        ttsBusy = false;
                    }
                }
            });
            ttsReady = true;
        } else {
            Toast.makeText(this, "Falha ao iniciar TTS", Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_FILE) {
            if (filePathCallback != null) {
                Uri[] results = (resultCode == RESULT_OK && data != null && data.getData() != null)
                        ? new Uri[]{data.getData()} : null;
                if (results != null && results.length > 0) {
                    try {
                        getContentResolver().takePersistableUriPermission(results[0],
                                Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    } catch (Exception ignored) {
                    }
                }
                filePathCallback.onReceiveValue(results);
                filePathCallback = null;
            }
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions,
                                           @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_REC_AUDIO) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                if (voiceWanted) startContinuousListening();
            } else {
                voiceWanted = false;
                jsCallback("onVoiceError", "\"sem-permissao\"");
            }
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        releaseRecognizer();
        if (tts != null) {
            tts.stop();
            tts.shutdown();
        }
        super.onDestroy();
    }
}
