(() => {
  "use strict";

  const messagesEl = document.getElementById("messages");
  const welcomeEl = document.getElementById("welcome");
  const inputEl = document.getElementById("input");
  const sendBtn = document.getElementById("sendBtn");
  const micBtn = document.getElementById("micBtn");
  const attachBtn = document.getElementById("attachBtn");
  const fileInput = document.getElementById("fileInput");
  const previewEl = document.getElementById("imagePreview");
  const newChatBtn = document.getElementById("newChatBtn");
  const ttsToggle = document.getElementById("ttsToggle");
  const voiceSelect = document.getElementById("voiceSelect");
  const rateSelect = document.getElementById("rateSelect");
  const providerSelect = document.getElementById("providerSelect");
  const genImgBtn = document.getElementById("genImgBtn");

  let history = [];
  let attachedImage = null; // { dataUrl, name }
  let busy = false;
  let currentAssistant = null; // { row, bubble, raw }
  let streamAbort = null;

  /* ---------------- Native (APK Android) vs Web (Flask) ---------------- */
  const IS_NATIVE = !!window.AndroidBridge;
  let NATIVE_CONFIG = {
    apiKey: "",
    model: "openai/gpt-oss-120b",
    visionModel: "qwen/qwen3.6-27b",
    geminiKey: "",
    geminiModel: "gemini-2.0-flash",
    openrouterKey: "",
    openrouterModel: "meta-llama/llama-3.3-70b-instruct:free",
    imageApiUrl: "https://image.pollinations.ai/prompt/",
    imageModel: "flux",
    providers: [],
  };
  const PROVIDER_LABEL = { auto: "Auto", groq: "Groq", gemini: "Gemini", openrouter: "OpenRouter" };

  if (IS_NATIVE) {
    try {
      const raw = window.AndroidBridge.getConfig();
      if (raw) NATIVE_CONFIG = Object.assign({}, NATIVE_CONFIG, JSON.parse(raw));
    } catch (e) { /* ignore */ }
    fetch("config.json")
      .then((r) => r.json())
      .then((c) => {
        NATIVE_CONFIG = Object.assign({}, NATIVE_CONFIG, c);
        fillProviders(nativeProviderList());
      })
      .catch(() => fillProviders(nativeProviderList()));
    voiceSelect.style.display = "none";
    fillProviders(nativeProviderList());
  } else {
    fetch("/api/health")
      .then((r) => r.json())
      .then((h) => fillProviders(h.providers || []))
      .catch(() => fillProviders(["groq"]));
  }

  function nativeProviderList() {
    const list = [];
    if (NATIVE_CONFIG.apiKey && NATIVE_CONFIG.apiKey !== "CHAVE_NAO_CONFIGURADA") list.push("groq");
    if (NATIVE_CONFIG.geminiKey) list.push("gemini");
    if (NATIVE_CONFIG.openrouterKey) list.push("openrouter");
    return list;
  }

  function fillProviders(list) {
    if (!providerSelect) return;
    const cur = providerSelect.value || "auto";
    providerSelect.innerHTML = "";
    const opts = ["auto"].concat((list || []).filter((p) => p && p !== "auto"));
    opts.forEach((p) => {
      const opt = document.createElement("option");
      opt.value = p;
      opt.textContent = PROVIDER_LABEL[p] || p;
      providerSelect.appendChild(opt);
    });
    providerSelect.value = opts.indexOf(cur) >= 0 ? cur : "auto";
  }

  function chosenProvider() {
    return (providerSelect && providerSelect.value) || "auto";
  }

  function nativeHasKey(name) {
    if (name === "groq") return !!(NATIVE_CONFIG.apiKey && NATIVE_CONFIG.apiKey !== "CHAVE_NAO_CONFIGURADA");
    if (name === "gemini") return !!NATIVE_CONFIG.geminiKey;
    if (name === "openrouter") return !!NATIVE_CONFIG.openrouterKey;
    return false;
  }

  function nativeOrder(requested) {
    const have = nativeProviderList();
    const req = (requested || "auto").toLowerCase();
    if (req !== "auto" && have.indexOf(req) >= 0) return [req].concat(have.filter((p) => p !== req));
    return have;
  }

  /* ---------------- Toast ---------------- */
  let toastTimer = null;
  function toast(msg, ms) {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), ms || 2600);
  }

  /* ---------------- Markdown ---------------- */
  if (window.marked && window.marked.setOptions) {
    window.marked.setOptions({ gfm: true, breaks: true });
  }
  function escapeHtml(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function sanitizeLinks(root) {
    root.querySelectorAll("a[href]").forEach((a) => {
      const h = a.getAttribute("href") || "";
      if (/^(javascript|vbscript|data):/i.test(h)) a.removeAttribute("href");
    });
  }
  function renderMarkdown(md) {
    const esc = escapeHtml(md);
    if (window.marked) return marked.parse(esc);
    return esc.replace(/\n/g, "<br>");
  }
  function setBubbleHTML(assistant, text) {
    assistant.bubble.innerHTML = renderMarkdown(text) + `<span class="caret"></span>`;
    sanitizeLinks(assistant.bubble);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  function finalizeBubble(assistant) {
    if (assistant.imageGen) return;
    if (assistant.renderTimer) {
      clearTimeout(assistant.renderTimer);
      assistant.renderTimer = null;
    }
    if (assistant.bubble.querySelector(".caret")) {
      assistant.bubble.innerHTML = renderMarkdown(stripThink(assistant.raw));
      sanitizeLinks(assistant.bubble);
    }
    addCodeDownloads(assistant.bubble);
  }

  /* ---------------- Native TTS (voz nativa do aparelho) ---------------- */
  let ttsEnabled = ttsToggle.checked;
  let ttsQueue = [];
  let ttsSpeaking = false;
  let currentUtterance = null;
  let playingMsg = null; // assistant row currently narrating

  /* Remove símbolos de Markdown para que a narração saia limpa */
  function cleanForSpeech(s) {
    if (!s) return "";
    let t = s;
    t = t.replace(/```[\s\S]*?```/g, " bloco de código. ");
    t = t.replace(/`([^`\n]*)`/g, " $1 ");
    t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
    t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
    t = t.replace(/^#{1,6}\s*/gm, "");
    t = t.replace(/^\s*[-*+]\s+/gm, "");
    t = t.replace(/^\s*\d+\.\s+/gm, "");
    t = t.replace(/[*_~|]+/g, " ");
    t = t.replace(/<[^>]+>/g, " ");
    t = t.replace(/ +([.,;:!?])/g, "$1");
    t = t.replace(/[ \t]{2,}/g, " ").replace(/ ?\n ?/g, " ");
    return t.trim();
  }

  function ttsSpeak(text) {
    if (!ttsEnabled) return;
    const clean = cleanForSpeech(text);
    if (!clean.trim()) return;
    if (IS_NATIVE) {
      window.AndroidBridge.speak(clean);
      return;
    }
    if (!window.speechSynthesis) return;
    ttsQueue.push(clean);
    processTtsQueue();
  }
  function ttsStopAll() {
    ttsQueue = [];
    ttsSpeaking = false;
    currentUtterance = null;
    if (IS_NATIVE) {
      window.AndroidBridge.stopSpeak();
      setPlayingMsg(null);
      return;
    }
    if (window.speechSynthesis) speechSynthesis.cancel();
    setPlayingMsg(null);
  }
  function ttsApplyRate(rate) {
    if (IS_NATIVE) {
      window.AndroidBridge.setRate(rate);
      return;
    }
    if (window.speechSynthesis) {
      speechSynthesis.cancel();
    }
  }
  function setPlayingMsg(assistant) {
    if (playingMsg && playingMsg.row) {
      const b = playingMsg.row.querySelector(".speak-btn");
      if (b) b.classList.remove("playing");
    }
    playingMsg = assistant;
    if (assistant && assistant.row) {
      const b = assistant.row.querySelector(".speak-btn");
      if (b) b.classList.add("playing");
    }
  }

  function loadVoices() {
    const voices = window.speechSynthesis ? speechSynthesis.getVoices() : [];
    const ptVoices = voices.filter((v) => /pt/i.test(v.lang));
    const list = ptVoices.length ? ptVoices : voices;
    const prev = voiceSelect.value;
    voiceSelect.innerHTML = "";
    list.forEach((v, i) => {
      const opt = document.createElement("option");
      opt.value = i;
      opt.textContent = `${v.name} (${v.lang})`;
      voiceSelect.appendChild(opt);
    });
    if (list.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "Voz padrão do aparelho";
      voiceSelect.appendChild(opt);
    } else if (prev !== "") {
      voiceSelect.value = prev;
    }
  }
  if (!IS_NATIVE && window.speechSynthesis) {
    loadVoices();
    speechSynthesis.onvoiceschanged = loadVoices;
  }

  function pickVoice() {
    if (!window.speechSynthesis || voiceSelect.value === "") return null;
    const voices = speechSynthesis.getVoices();
    const idx = parseInt(voiceSelect.value, 10);
    const list = voices.filter((v) => /pt/i.test(v.lang));
    const arr = list.length ? list : voices;
    return arr[idx] || null;
  }

  function processTtsQueue() {
    if (!ttsEnabled || ttsSpeaking || ttsQueue.length === 0) return;
    const text = ttsQueue.shift();
    if (!text.trim()) { processTtsQueue(); return; }
    ttsSpeaking = true;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = (pickVoice() && pickVoice().lang) || "pt-BR";
    u.voice = pickVoice();
    u.rate = parseFloat(rateSelect.value);
    u.pitch = 1;
    u.onend = () => { ttsSpeaking = false; currentUtterance = null; processTtsQueue(); };
    u.onerror = () => { ttsSpeaking = false; currentUtterance = null; processTtsQueue(); };
    currentUtterance = u;
    speechSynthesis.speak(u);
  }

  ttsToggle.addEventListener("change", () => {
    ttsEnabled = ttsToggle.checked;
    if (!ttsEnabled) ttsStopAll();
  });

  rateSelect.addEventListener("change", () => ttsApplyRate(parseFloat(rateSelect.value)));

  /* Sentence buffer -> speak complete sentences while streaming */
  const sentenceBuffer = { text: "" };
  function flushSentences() {
    const buf = sentenceBuffer.text;
    if (!buf) return;
    let lastEnd = -1;
    for (let j = 0; j < buf.length; j++) {
      if (".!?…".indexOf(buf[j]) !== -1) lastEnd = j;
    }
    if (lastEnd === -1) return;
    const tail = buf.slice(lastEnd + 1);
    if (tail.length > 0 && !/^\s/.test(tail)) return;
    const complete = buf.slice(0, lastEnd + 1).trim();
    if (complete) ttsSpeak(complete);
    sentenceBuffer.text = buf.slice(lastEnd + 1);
  }

  /* ---------------- Files ---------------- */
  const FILE_EXT = {
    py: "py", python: "py", js: "js", javascript: "js", ts: "ts", typescript: "ts",
    java: "java", kotlin: "kt", html: "html", css: "css", scss: "scss",
    json: "json", csv: "csv", tsv: "tsv", xml: "xml", yaml: "yml", yml: "yml",
    sql: "sql", sh: "sh", bash: "sh", shell: "sh", zsh: "zsh", ps1: "ps1",
    md: "md", markdown: "md", txt: "txt", text: "txt", ini: "ini", env: "env",
    dockerfile: "dockerfile", gitignore: "gitignore", toml: "toml",
    c: "c", cpp: "cpp", h: "h", go: "go", rs: "rs", rb: "rb", php: "php",
    swift: "swift", dart: "dart", vue: "vue", jsx: "jsx", tsx: "tsx",
  };

  function downloadFile(filename, content) {
    if (IS_NATIVE) {
      try {
        window.AndroidBridge.saveFile(filename, content);
        toast("Arquivo salvo: " + filename);
      } catch (e) {
        toast("Falha ao salvar arquivo");
      }
      return;
    }
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast("Download iniciado: " + filename);
  }

  function addCodeDownloads(bubble) {
    bubble.querySelectorAll("pre").forEach((pre, idx) => {
      if (pre.closest(".code-toolbar")) return;
      const code = pre.querySelector("code");
      if (!code) return;
      const cls = code.className || "";
      const m = /language-([\w-]+)/.exec(cls);
      const lang = m ? m[1].toLowerCase() : "txt";
      const ext = FILE_EXT[lang] || "txt";
      const wrap = document.createElement("div");
      wrap.className = "code-toolbar";
      pre.parentNode.replaceChild(wrap, pre);
      const head = document.createElement("div");
      head.className = "code-head";
      const label = document.createElement("span");
      label.textContent = lang;
      head.appendChild(label);
      const dl = document.createElement("button");
      dl.className = "code-dl";
      dl.textContent = "Baixar ." + ext;
      dl.addEventListener("click", () => downloadFile(`arquivo-${idx + 1}.${ext}`, code.textContent));
      head.appendChild(dl);
      wrap.appendChild(head);
      wrap.appendChild(pre);
    });
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast("Copiado para a área de transferência");
    } catch (e) {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        toast("Copiado para a área de transferência");
      } catch (e2) {
        toast("Falha ao copiar");
      }
      ta.remove();
    }
  }

  /* ---------------- Message rendering ---------------- */
  function addUserMessage(text, image) {
    const row = document.createElement("div");
    row.className = "row user";
    row.innerHTML = `
      <div class="avatar">EU</div>
      <div class="bubble"></div>`;
    const bubble = row.querySelector(".bubble");
    if (image) {
      bubble.innerHTML = `<img class="attached" src="${image.dataUrl}" alt="imagem anexada">`;
      bubble.innerHTML += `<span class="ocr-tag">Imagem &middot; leitura inteligente</span>`;
      if (text) bubble.innerHTML += renderMarkdown(escapeHtml(text));
    } else {
      bubble.innerHTML = renderMarkdown(escapeHtml(text));
    }
    messagesEl.appendChild(row);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function addAssistantMessage() {
    const row = document.createElement("div");
    row.className = "row assistant";
    row.innerHTML = `
      <div class="avatar">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 11a7 7 0 0 1-14 0"/><line x1="12" y1="18" x2="12" y2="22"/></svg>
      </div>
      <div style="flex:1;min-width:0">
        <div class="bubble"><span class="typing"><span></span><span></span><span></span></span></div>
        <div class="actions"></div>
      </div>`;
    messagesEl.appendChild(row);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    const assistant = { row, bubble: row.querySelector(".bubble"), raw: "", displayLen: 0, streaming: true, ttsOn: true };
    return assistant;
  }

  function attachActions(assistant) {
    const actions = assistant.row.querySelector(".actions");
    if (!actions) return;

    const mk = (label, cls, svg) => {
      const b = document.createElement("button");
      b.className = cls;
      b.innerHTML = svg + " " + label;
      actions.appendChild(b);
      return b;
    };
    const icoSpeaker = `<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3z"/><path d="M16.5 12a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z"/></svg>`;
    const icoCopy = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>`;
    const icoDl = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0l-4-4m4 4l4-4"/><path d="M4 21h16"/></svg>`;

    const speak = mk("Narrar", "speak-btn", icoSpeaker);
    speak.addEventListener("click", () => {
      if (playingMsg === assistant && (IS_NATIVE || ttsSpeaking || ttsQueue.length)) {
        ttsStopAll();
        return;
      }
      if (!ttsEnabled) {
        ttsToggle.checked = true;
        ttsEnabled = true;
      }
      ttsStopAll();
      setPlayingMsg(assistant);
      ttsSpeak(assistant.raw);
    });

    const copy = mk("Copiar", "speak-btn", icoCopy);
    copy.addEventListener("click", () => copyText(stripThink(assistant.raw)));

    const dl = mk("Baixar .md", "speak-btn", icoDl);
    dl.addEventListener("click", () => downloadFile("resposta.md", stripThink(assistant.raw)));
  }

  /* ---------------- Image attach ---------------- */
  let nativeOcrResult = "";
  let nativeOcrPending = false;
  window.onOcrResult = (token, text) => {
    nativeOcrResult = text || "";
    nativeOcrPending = false;
  };

  attachBtn.addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      attachedImage = { dataUrl: e.target.result, name: file.name };
      renderImagePreview();
      if (IS_NATIVE) {
        nativeOcrResult = "";
        nativeOcrPending = true;
        const token = "ocr-" + Math.random().toString(36).slice(2);
        window.AndroidBridge.ocrBase64(attachedImage.dataUrl, token);
      }
    };
    reader.readAsDataURL(file);
    fileInput.value = "";
  });

  function renderImagePreview() {
    previewEl.innerHTML = "";
    if (!attachedImage) { previewEl.classList.remove("show"); return; }
    previewEl.classList.add("show");
    const wrap = document.createElement("div");
    wrap.className = "thumb-wrap";
    wrap.innerHTML = `<img src="${attachedImage.dataUrl}" alt="anexo">`;
    const rm = document.createElement("button");
    rm.className = "remove-img";
    rm.textContent = "x";
    rm.addEventListener("click", () => { attachedImage = null; renderImagePreview(); });
    wrap.appendChild(rm);
    previewEl.appendChild(wrap);
  }

  /* ---------------- Voz: conversa mãos-livres ----------------
   * Tocar o microfone liga o modo mãos-livres: o YuIA fica em escuta contínua
   * (sem o dialog do Google). Quando você faz uma pausa de ~2-3s no fim da
   * fala, ele envia a mensagem sozinho. Enquanto a resposta é narrada ele não
   * escuta e, ao terminar, volta a escutar sozinho — até você desligar o botão.
   * No Android usa o SpeechRecognizer nativo; no navegador, a Web Speech API. */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  let handsFreeOn = false;   // mãos-livres ligado/desligado pelo usuário
  let recSession = null;     // sessão de reconhecimento ativa (só web)
  let listeningNow = false;  // há uma escuta em andamento agora
  let relistenTimer = null;  // poll p/ reabrir a escuta após a resposta falada
  let lastVoiceToastTs = 0;  // controle p/ não spammar toasts de erro de voz

  function setMicState(state) {
    micBtn.classList.toggle("recording", state);
    micBtn.title = state ? "Mãos-livres ativo · toque para parar" : "Conversa por voz (mãos-livres)";
  }

  function setListeningUi(on) {
    if (!handsFreeOn) return;
    micBtn.classList.toggle("listening", !!on);
  }

  /* O TTS terminou? (nativo pergunta ao Android; na web usa a fila interna) */
  function ttsIdle() {
    if (IS_NATIVE) {
      try { return !window.AndroidBridge.isSpeaking(); } catch (e) { return true; }
    }
    if (!window.speechSynthesis) return true;
    return !window.speechSynthesis.speaking && !ttsSpeaking && ttsQueue.length === 0;
  }

  function showTranscribed(text) {
    inputEl.value = text || "";
    autoResize();
    updateSendBtn();
  }

  /* Envia a frase reconhecida como se tivesse sido digitada. */
  function submitVoice(text) {
    if (!handsFreeOn) return;
    const msg = (text || "").trim();
    listeningNow = false;
    setListeningUi(false);
    if (!msg) { scheduleRelisten(); return; }
    if (busy) { scheduleRelisten(); return; } // não interrompe uma resposta em andamento
    showTranscribed(msg);
    send();
  }

  function stopWebRec() {
    if (recSession) {
      try { recSession.stop(); } catch (e) { /* ignore */ }
      recSession = null;
    }
    listeningNow = false;
    setListeningUi(false);
  }

  function startVoiceListen() {
    if (!handsFreeOn) return;
    if (IS_NATIVE) {
      try {
        window.AndroidBridge.startVoice();
        listeningNow = true;
        setListeningUi(true);
      } catch (e) {
        setHandsFreeOff();
      }
      return;
    }
    if (!SR) {
      alert("Reconhecimento de voz não suportado neste navegador. Use o Chrome no Android.");
      setHandsFreeOff();
      return;
    }
    stopWebRec();
    try {
      const rec = new SR();
      recSession = rec;
      rec.lang = (pickVoice() && pickVoice().lang) || "pt-BR";
      rec.interimResults = true;
      rec.continuous = false; // uma frase por sessão (a pausa ~2-3s encerra)
      listeningNow = true;
      setListeningUi(true);
      rec.onresult = (e) => {
        let t = "";
        let fin = false;
        for (let i = 0; i < e.results.length; i++) {
          t += e.results[i][0].transcript;
          if (e.results[i].isFinal) fin = true;
        }
        if (fin) {
          stopWebRec();
          submitVoice(t);
        } else {
          showTranscribed(t);
        }
      };
      rec.onend = () => {
        listeningNow = false;
        setListeningUi(false);
        if (recSession === rec) recSession = null;
        if (handsFreeOn) scheduleRelisten();
      };
      rec.onerror = (e) => {
        if (recSession === rec) recSession = null;
        listeningNow = false;
        setListeningUi(false);
        if (e.error && e.error !== "aborted" && e.error !== "no-speech") {
          toast("Erro no microfone: " + e.error, 1800);
        }
        if (handsFreeOn) scheduleRelisten();
      };
      rec.start();
    } catch (err) {
      listeningNow = false;
      setListeningUi(false);
      alert("Não foi possível iniciar o microfone: " + err.message);
      setHandsFreeOff();
    }
  }

  function stopVoiceListen() {
    if (IS_NATIVE) {
      try { window.AndroidBridge.stopVoice(); } catch (e) { /* ignore */ }
    } else {
      stopWebRec();
    }
    listeningNow = false;
    setListeningUi(false);
  }

  /* Reabre a escuta quando: ligado, sem resposta em andamento e voz parada. */
  function scheduleRelisten() {
    if (!handsFreeOn || listeningNow || busy) return;
    clearInterval(relistenTimer);
    let waited = 0;
    relistenTimer = setInterval(() => {
      waited += 250;
      if (!handsFreeOn || listeningNow || busy) return;
      if (waited > 60000 || !ttsIdle()) return;
      clearInterval(relistenTimer);
      relistenTimer = null;
      startVoiceListen();
    }, 250);
  }

  function setHandsFreeOn() {
    handsFreeOn = true;
    setMicState(true);
    if (!ttsEnabled) { ttsToggle.checked = true; ttsEnabled = true; }
    ttsStopAll();
    startVoiceListen();
  }

  function setHandsFreeOff() {
    handsFreeOn = false;
    clearInterval(relistenTimer);
    relistenTimer = null;
    stopVoiceListen();
    setMicState(false);
    ttsStopAll();
  }

  micBtn.addEventListener("click", () => {
    if (handsFreeOn) setHandsFreeOff();
    else setHandsFreeOn();
  });

  /* Callbacks nativos (Android -> JS). O Java só reporta; quem decide a
   * re-escuta é este JS. */
  window.onVoicePartial = (text) => {
    if (handsFreeOn && listeningNow) showTranscribed(text);
  };
  window.onVoiceFinal = (text) => {
    if (!handsFreeOn) return;
    submitVoice(text);
  };
  window.onVoiceError = (msg) => {
    if (!handsFreeOn) return;
    listeningNow = false;
    setListeningUi(false);
    if ((msg || "").indexOf("permiss") !== -1 || msg === "sem-permissao" || (msg || "").indexOf("indispon") !== -1) {
      toast("Não foi possível usar o microfone neste aparelho");
      setHandsFreeOff();
      return;
    }
    // Erros silenciosos (timeout, "não entendi") são normais na escuta contínua:
    // evita spam de toast e apenas reabre a escuta.
    const now = Date.now();
    if (now - lastVoiceToastTs > 4500) {
      lastVoiceToastTs = now;
      toast("Microfone: " + msg, 1600);
    }
    scheduleRelisten();
  };

  /* ---------------- Send / stream ---------------- */
  function autoResize() {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 150) + "px";
  }
  inputEl.addEventListener("input", autoResize);

  function sendDisabled() {
    return busy || (inputEl.value.trim() === "" && !attachedImage);
  }

  function updateSendBtn() {
    if (busy) {
      sendBtn.classList.add("stop");
      sendBtn.title = "Parar resposta";
      sendBtn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`;
    } else {
      sendBtn.classList.remove("stop");
      sendBtn.title = "Enviar";
      sendBtn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg>`;
      sendBtn.disabled = sendDisabled();
    }
  }

  function resetComposer() {
    inputEl.value = "";
    attachedImage = null;
    renderImagePreview();
    autoResize();
  }

  /* Aplica um trecho de texto na bolha e narra (comum aos dois modos) */
  function stripThink(s) {
    if (!s) return s;
    return s.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "");
  }

  function scheduleRender(assistant) {
    if (assistant.renderTimer) return;
    assistant.renderTimer = setTimeout(() => {
      assistant.renderTimer = null;
      if (!assistant.raw) return;
      setBubbleHTML(assistant, stripThink(assistant.raw));
    }, 40);
  }

  function applyDelta(assistant, content) {
    if (!content) return;
    assistant.raw += content;
    const display = stripThink(assistant.raw);
    const delta = display.slice(assistant.displayLen || 0);
    assistant.displayLen = display.length;
    if (delta && assistant.ttsOn) {
      sentenceBuffer.text += delta;
      flushSentences();
    }
    scheduleRender(assistant);
  }

  /* Lê o corpo SSE (aceita tanto /api/chat quanto a API da Groq) */
  async function consumeStream(body, onLine, onDone) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const chunks = buf.split("\n\n");
      buf = chunks.pop();
      for (const chunk of chunks) {
        for (const line of chunk.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const raw = trimmed.slice(5).trim();
          if (raw === "[DONE]") continue;
          if (raw) onLine(raw);
        }
      }
    }
    const trimmed = buf.trim();
    if (trimmed.startsWith("data:")) {
      const raw = trimmed.slice(5).trim();
      if (raw && raw !== "[DONE]") onLine(raw);
    }
    onDone();
  }

  function parseDelta(raw) {
    let evt;
    try { evt = JSON.parse(raw); } catch { return null; }
    if (evt.type === "delta") return evt.content;
    if (evt.choices && evt.choices[0] && evt.choices[0].delta) {
      return evt.choices[0].delta.content;
    }
    return null;
  }

  function reasoningParam(model) {
    const m = (model || "").toLowerCase();
    if (m.indexOf("qwen") !== -1) return { reasoning_effort: "none" };
    if (m.indexOf("gpt-oss") !== -1) return { reasoning_effort: "low" };
    return {};
  }

  async function openaiCompatStream(url, apiKey, model, messages, controller, onLine, maxTokens, extraHeaders, extraBody) {
    const headers = Object.assign({
      "Content-Type": "application/json",
      Authorization: "Bearer " + apiKey,
    }, extraHeaders || {});
    const body = Object.assign({
      model: model,
      messages: messages,
      stream: true,
      temperature: 0.7,
      max_tokens: maxTokens || 1500,
    }, extraBody || {});
    const resp = await fetch(url, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok || !resp.body) {
      throw new Error("Erro da API (HTTP " + resp.status + ")");
    }
    await consumeStream(resp.body, (raw) => {
      const c = parseDelta(raw);
      if (c) onLine(c);
    }, () => {});
  }

  async function groqStream(model, messages, controller, onLine, maxTokens) {
    await openaiCompatStream(
      "https://api.groq.com/openai/v1/chat/completions",
      NATIVE_CONFIG.apiKey,
      model,
      messages,
      controller,
      onLine,
      maxTokens,
      null,
      reasoningParam(model)
    );
  }

  async function geminiStream(model, messages, controller, onLine, maxTokens) {
    await openaiCompatStream(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      NATIVE_CONFIG.geminiKey,
      model || "gemini-2.0-flash",
      messages,
      controller,
      onLine,
      maxTokens
    );
  }

  async function openrouterStream(model, messages, controller, onLine, maxTokens) {
    await openaiCompatStream(
      "https://openrouter.ai/api/v1/chat/completions",
      NATIVE_CONFIG.openrouterKey,
      model || "meta-llama/llama-3.3-70b-instruct:free",
      messages,
      controller,
      onLine,
      maxTokens,
      { "HTTP-Referer": "https://github.com/jt168304-sys/ia-assistente", "X-Title": "YuIA" }
    );
  }

  async function nativeChatStream(provider, messages, controller, onLine, vision) {
    if (provider === "groq") {
      const model = vision && NATIVE_CONFIG.visionModel && NATIVE_CONFIG.visionModel.toLowerCase() !== "none"
        ? NATIVE_CONFIG.visionModel
        : NATIVE_CONFIG.model;
      await groqStream(model, messages, controller, onLine);
      return;
    }
    if (provider === "gemini") {
      await geminiStream(NATIVE_CONFIG.geminiModel, messages, controller, onLine);
      return;
    }
    if (provider === "openrouter") {
      await openrouterStream(NATIVE_CONFIG.openrouterModel, messages, controller, onLine);
    }
  }

  function currentDateTime() {
    try {
      const d = new Date();
      return (
        "hoje é " + d.toLocaleDateString("pt-BR") +
        " e agora são " + d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) +
        " (horário do celular)"
      );
    } catch (e) {
      return "";
    }
  }

  function nativeGroqMessages(text, image, ocrText) {
    const msgs = [{
      role: "system",
      content:
        "Você é um assistente pessoal inteligente, amigável e preciso, chamado YuIA. " +
        "Responda SEMPRE em português do Brasil (pt-BR). Regra rígida: jamais responda em " +
        "inglês, espanhol ou outro idioma — entenda o usuário em qualquer idioma, mas escreva " +
        "tudo em português. Termos técnicos, nomes de bibliotecas e comandos podem ficar em " +
        "inglês, mas a explicação sempre em português. " +
        "Seja CONCISO: responda de forma direta e enxuta, sem introduções longas, sem " +
        "repetição. Prefira respostas curtas (2 a 5 parágrafos no máximo, ou listas curtas). " +
        "Não enumere tudo o que sabe — responda apenas o que foi perguntado. " +
        "NUNCA invente informações: se você não souber ou não tiver certeza, diga " +
        "claramente que não sabe ou que não encontrou a informação. Jamais invente fatos, " +
        "URLs, números, nomes de vídeos, canais, obras, autores ou dados — nem mesmo para " +
        "parecer útil. Responda apenas com base no que realmente sabe ou nos resultados de " +
        "pesquisa fornecidos no contexto. " +
        currentDateTime() + ". Use isso para perguntas sobre data e hora. " +
        "Quando o usuário anexar uma imagem, o texto extraído dela via OCR será " +
        "fornecido no contexto — use-o para responder perguntas sobre o conteúdo. " +
        "Formate respostas com Markdown quando fizer sentido. Prefira hífens (-) em listas " +
        "em vez de asteriscos, e evite asteriscos de ênfase (*texto*) para que a narração " +
        "por voz saia limpa. Quando o usuário pedir para criar um arquivo, entregue o " +
        "conteúdo completo dentro de um bloco de código. Recuse apenas pedidos claramente " +
        "ilegais (crime, exploração de menores, armas, ataques).",
    }, ...trimHistory(history, 12)];
    let content = text || "Analise o conteúdo desta imagem e descreva o que você enxerga.";
    if (ocrText) content += "\n\nTexto extraído da imagem (OCR):\n" + ocrText;
    msgs.push({ role: "user", content });
    return msgs;
  }

  function nativeVisionMessages(text, dataUrl, ocrText) {
    const msgs = [{
      role: "system",
      content:
        "Você é um assistente pessoal inteligente com visão, chamado YuIA. Responda SEMPRE " +
        "em português do Brasil (pt-BR), analisando diretamente a imagem fornecida. " +
        "Jamais responda em inglês ou outro idioma; a descrição da imagem deve ser em " +
        "português. Seja CONCISO: descreva o essencial, sem excesso de detalhes e sem " +
        "repetição (2 a 5 parágrafos no máximo). " + currentDateTime() + ". Se houver texto " +
        "OCR auxiliar, use-o para complementar a leitura. Formate com Markdown quando fizer " +
        "sentido, evitando asteriscos de ênfase.",
    }, ...trimHistory(history, 12)];
    const parts = [];
    if (text) parts.push({ type: "text", text });
    else parts.push({ type: "text", text: "Analise esta imagem e descreva detalhadamente o que você enxerga." });
    parts.push({ type: "image_url", image_url: { url: dataUrl } });
    if (ocrText) parts.push({ type: "text", text: "Texto OCR auxiliar:\n" + ocrText });
    msgs.push({ role: "user", content: parts });
    return msgs;
  }

  function trimHistory(arr, n) {
    if (!arr || arr.length <= n) return arr;
    return arr.slice(arr.length - n);
  }

  /* Busca nativa assíncrona: o bridge roda em thread própria e devolve o
   * resultado via window.onWebSearchResult. Timeout de 8s evita travar o chat. */
  const pendingSearches = {};
  window.onWebSearchResult = (token, json) => {
    const done = pendingSearches[token];
    if (done) { done(json || "[]"); delete pendingSearches[token]; }
  };

  function nativeWebSearch(query) {
    return new Promise((resolve) => {
      try {
        if (!window.AndroidBridge.webSearchAsync) { resolve(""); return; }
        const token = "ws-" + Math.random().toString(36).slice(2);
        const timer = setTimeout(() => {
          delete pendingSearches[token];
          resolve("");
        }, 20000);
        pendingSearches[token] = (json) => {
          clearTimeout(timer);
          try {
            const list = JSON.parse(json || "[]");
            const lines = list.slice(0, 5).map(
              (r, i) => `${i + 1}. ${r.title || ""}\n   URL: ${r.url || ""}\n   ${(r.snippet || "").slice(0, 220)}`
            );
            resolve(lines.join("\n\n"));
          } catch (e) {
            resolve("");
          }
        };
        window.AndroidBridge.webSearchAsync(query, token);
      } catch (e) {
        resolve("");
      }
    });
  }

  function injectSearchContext(messages, context) {
    if (!context) return messages;
    const hint =
      "Resultados de pesquisa na web sobre a pergunta do usuário. Se a pergunta exigir " +
      "informação externa ou atual, responda APENAS com base nesses resultados. Use " +
      "inclusive trechos parciais; se nenhum resultado responder de fato, diga " +
      "claramente que não encontrou informação confiável. Cite as fontes (URLs) quando " +
      "útil. Não invente dados, nomes, vídeos, canais nem URLs que não estejam nos " +
      "resultados:";
    const msgs = messages.slice();
    msgs.splice(msgs.length - 1, 0, { role: "system", content: hint + "\n\n" + context });
    return msgs;
  }

  /* Evita gastar uma busca a cada mensagem: só busca quando a pergunta parece
   * exigir informação externa/atual. Cumprimentos e falas curtas ("oi",
   * "obrigado", "ok") respondem direto, sem esperar a web. */
  function shouldAutoSearch(text) {
    const t = (text || "").trim();
    if (!t) return false;
    if (looksLikeImageRequest(t)) return false;
    if (t.length >= 22) return true;
    if (/\b(quem|o que|qual|onde|quando|como|por que|porque|not[íi]cia|atual|resultado|pre[çc]o|valor|diferen[çc]a|melhor|existe|regras?|hoje|agora)\b/i.test(t)) return true;
    return /\?$/.test(t);
  }

  function looksLikeImageRequest(text) {
    const t = (text || "").trim().toLowerCase();
    if (!t) return false;
    return /\b(gere|gerar|gera|crie|criar|desenhe|desenhar|pinte|pintar|ilustre|ilustrar)\b.{0,40}\b(imagem|foto|desenho|ilustra|picture|image)\b/.test(t)
      || /\b(imagem|foto|desenho) de\b/.test(t)
      || /\bgenerate (an |a )?image\b/.test(t);
  }

  function imageApiBase() {
    const base = (NATIVE_CONFIG.imageApiUrl || "https://image.pollinations.ai/prompt/").replace(/\/?$/, "/");
    return base;
  }

  function pollinationsUrl(prompt) {
    const model = NATIVE_CONFIG.imageModel || "flux";
    const seed = Math.floor(Math.random() * 999999) + 1;
    return imageApiBase() + encodeURIComponent(prompt)
      + "?model=" + encodeURIComponent(model)
      + "&width=1024&height=1024&nologo=true&enhance=true&seed=" + seed;
  }

  async function refineImagePrompt(subject, refs) {
    const msgs = [
      {
        role: "system",
        content: "You write image-generation prompts. Reply with ONE English prompt only, no quotes, no markdown. Describe subject, style, composition, lighting. Avoid extra limbs and warped faces. Under 80 words.",
      },
      {
        role: "user",
        content: "Subject: " + subject + (refs ? "\nWeb refs:\n" + refs.slice(0, 900) : ""),
      },
    ];
    let out = "";
    const controller = new AbortController();
    const order = nativeOrder("auto");
    for (let i = 0; i < order.length; i++) {
      try {
        await nativeChatStream(order[i], msgs, controller, (c) => { out += c; }, false);
        break;
      } catch (e) { /* try next */ }
    }
    out = (out || "").replace(/^['"`]+|['"`]+$/g, "").trim();
    if (out.length > 12) return out;
    return subject + ", highly detailed, sharp focus, coherent anatomy, natural lighting, professional digital art, 8k";
  }

  function renderGeneratedImage(assistant, imgUrl, caption) {
    const img = document.createElement("img");
    img.className = "generated";
    img.alt = "imagem gerada";
    img.src = imgUrl;
    img.addEventListener("error", () => {
      toast("Falha ao carregar a imagem gerada");
    });
    assistant.bubble.innerHTML = "";
    assistant.bubble.appendChild(img);
    if (caption) {
      const p = document.createElement("p");
      p.className = "gen-caption";
      p.textContent = caption;
      assistant.bubble.appendChild(p);
    }
    const dl = document.createElement("button");
    dl.className = "code-dl";
    dl.textContent = "Baixar imagem";
    dl.addEventListener("click", () => {
      if (IS_NATIVE) {
        try {
          window.AndroidBridge.saveImage(imgUrl, "yuia-" + Date.now() + ".jpg");
          toast("Salvando imagem");
        } catch (e) {
          toast("Falha ao salvar imagem");
        }
      } else {
        const a = document.createElement("a");
        a.href = imgUrl;
        a.download = "yuia-imagem.jpg";
        a.target = "_blank";
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
    });
    assistant.bubble.appendChild(dl);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  async function generateImageFlow(text, assistant, controller) {
    const subject = text.replace(/^(por favor[, ]*)?(pode |consegue )?(me )?(gere|gerar|gera|crie|criar|desenhe|desenhar|pinte|ilustre)\s+(uma |um )?(imagem|foto|desenho|ilustração)?\s*(de |do |da |com )?/i, "").trim() || text;
    if (IS_NATIVE) {
      let refs = "";
      try { refs = await nativeWebSearch(subject + " visual description"); } catch (e) { refs = ""; }
      const refined = await refineImagePrompt(subject, refs);
      const url = pollinationsUrl(refined);
      renderGeneratedImage(assistant, url, "Prompt: " + refined);
      assistant.raw = "Imagem gerada: " + refined;
      assistant.displayLen = assistant.raw.length;
      assistant.imageGen = true;
      return;
    }
    const resp = await fetch("/api/image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: text }),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error("Falha ao gerar imagem (HTTP " + resp.status + ")");
    const data = await resp.json();
    const src = data.data_url || data.url;
    if (!src) throw new Error("O serviço de imagem não devolveu resultado");
    renderGeneratedImage(assistant, src, data.prompt ? ("Prompt: " + data.prompt) : "");
    assistant.raw = "Imagem gerada: " + (data.prompt || text);
    assistant.displayLen = assistant.raw.length;
    assistant.imageGen = true;
  }

  async function send() {
    const text = inputEl.value.trim();
    const image = attachedImage;
    if (busy) {
      if (streamAbort) streamAbort.abort();
      busy = false;
      updateSendBtn();
      if (handsFreeOn) scheduleRelisten();
      return;
    }
    if (!text && !image) return;

    addUserMessage(text, image);
    const welcome = document.getElementById("welcome");
    if (welcome) welcome.remove();
    resetComposer();

    history.push({ role: "user", content: text || "[anexou uma imagem]" });

    const assistant = addAssistantMessage();
    const controller = new AbortController();
    streamAbort = controller;
    busy = true;
    updateSendBtn();
    currentAssistant = assistant;

    try {
      if (IS_NATIVE) {
        if (!nativeProviderList().length) {
          throw new Error("APK sem chave de API. Configure GROQ_API_KEY e/ou GEMINI_API_KEY nos secrets e recompile.");
        }
        if (text && !image && looksLikeImageRequest(text)) {
          await generateImageFlow(text, assistant, controller);
        } else {
        if (nativeOcrPending) {
          const t0 = Date.now();
          while (nativeOcrPending && Date.now() - t0 < 20000) {
            await new Promise((r) => setTimeout(r, 50));
          }
        }
        const hasVision = !!(image && NATIVE_CONFIG.visionModel && NATIVE_CONFIG.visionModel.toLowerCase() !== "none");
        let searchContext = "";
        if (text && shouldAutoSearch(text)) {
          searchContext = await nativeWebSearch(text);
        }
        const order = nativeOrder(chosenProvider());
        const runTextOcr = async () => {
          const msgs = injectSearchContext(nativeGroqMessages(text, image, nativeOcrResult), searchContext);
          let lastErr = null;
          for (let i = 0; i < order.length; i++) {
            try {
              await nativeChatStream(order[i], msgs, controller, (c) => applyDelta(assistant, c), false);
              return;
            } catch (e) { lastErr = e; }
          }
          if (lastErr) throw lastErr;
        };
        try {
          if (hasVision) {
            const vMsgs = injectSearchContext(nativeVisionMessages(text, image.dataUrl, nativeOcrResult), searchContext);
            try {
              await nativeChatStream("groq", vMsgs, controller, (c) => applyDelta(assistant, c), true);
            } catch (e) {
              if (nativeHasKey("gemini")) {
                await nativeChatStream("gemini", vMsgs, controller, (c) => applyDelta(assistant, c), true);
              } else {
                throw e;
              }
            }
            if ((!assistant.raw || !assistant.raw.trim()) && nativeOcrResult) {
              assistant.raw = "";
              assistant.displayLen = 0;
              assistant.bubble.innerHTML = `<span class="typing"><span></span><span></span><span></span></span>`;
              await runTextOcr();
            }
          } else {
            await runTextOcr();
          }
        } catch (visionErr) {
          if (hasVision && nativeOcrResult) {
            assistant.raw = "";
            assistant.displayLen = 0;
            assistant.bubble.innerHTML = `<span class="typing"><span></span><span></span><span></span></span>`;
            await runTextOcr();
          } else {
            throw visionErr;
          }
        }
        }
      } else {
        if (text && !image && looksLikeImageRequest(text)) {
          await generateImageFlow(text, assistant, controller);
        } else {
        const resp = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text, image: image ? image.dataUrl : null, history: trimHistory(history, 12), search: shouldAutoSearch(text), provider: chosenProvider() }),
          signal: controller.signal,
        });
        if (!resp.ok || !resp.body) {
          throw new Error("Falha na comunicação com o servidor (HTTP " + resp.status + ")");
        }
        await consumeStream(
          resp.body,
          (raw) => {
            let evt;
            try { evt = JSON.parse(raw); } catch { return; }
            if (evt.type === "delta") applyDelta(assistant, evt.content);
            else if (evt.type === "error") {
              assistant.bubble.classList.add("err-bubble");
              applyDelta(assistant, "\n\nErro: " + evt.content);
            }
          },
          () => {}
        );
        }
      }
      if (assistant.imageGen) {
        assistant.streaming = false;
        if (assistant.raw) history.push({ role: "assistant", content: stripThink(assistant.raw) });
      } else if (!assistant.raw || !assistant.raw.trim()) {
        assistant.raw =
          "Não consegui gerar uma resposta agora. Tente reformular a pergunta ou verifique a conexão.";
        assistant.displayLen = 0;
        setBubbleHTML(assistant, assistant.raw);
        if (sentenceBuffer.text.trim()) {
          ttsSpeak(sentenceBuffer.text.trim());
          sentenceBuffer.text = "";
        }
        finalizeBubble(assistant);
        assistant.streaming = false;
        attachActions(assistant);
        if (assistant.raw) history.push({ role: "assistant", content: stripThink(assistant.raw) });
      } else if (!assistant.imageGen) {
        if (sentenceBuffer.text.trim()) {
          ttsSpeak(sentenceBuffer.text.trim());
          sentenceBuffer.text = "";
        }
        finalizeBubble(assistant);
        assistant.streaming = false;
        attachActions(assistant);
        if (assistant.raw) history.push({ role: "assistant", content: stripThink(assistant.raw) });
      }
    } catch (err) {
      if (err.name === "AbortError") {
        if (sentenceBuffer.text.trim()) { ttsSpeak(sentenceBuffer.text.trim()); sentenceBuffer.text = ""; }
        if (assistant.raw) {
          finalizeBubble(assistant);
          attachActions(assistant);
        }
        assistant.bubble.classList.add("err-bubble");
        if (assistant.raw) assistant.raw += "\n\n_[resposta interrompida]_";
      if (assistant.raw) history.push({ role: "assistant", content: stripThink(assistant.raw) });
      } else {
        assistant.bubble.innerHTML = `<span class="err-bubble">Falha ao conectar: ${escapeHtml(err.message)}</span>`;
      }
    } finally {
      busy = false;
      streamAbort = null;
      updateSendBtn();
      inputEl.focus();
      if (handsFreeOn) scheduleRelisten();
    }
  }

  if (genImgBtn) {
    genImgBtn.addEventListener("click", () => {
      const t = inputEl.value.trim();
      if (!t) {
        toast("Digite o que deseja gerar e toque na paleta");
        inputEl.focus();
        return;
      }
      if (!looksLikeImageRequest(t)) {
        inputEl.value = "Gere uma imagem de " + t;
        autoResize();
      }
      send();
    });
  }

  sendBtn.addEventListener("click", send);
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  inputEl.addEventListener("input", updateSendBtn);

  /* ---------------- Suggestions & new chat ---------------- */
  document.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (chip) {
      inputEl.value = chip.dataset.q;
      autoResize();
      updateSendBtn();
      inputEl.focus();
    }
  });

  newChatBtn.addEventListener("click", () => {
    ttsStopAll();
    history = [];
    messagesEl.innerHTML = "";
    const welcome = document.createElement("div");
    welcome.className = "welcome";
    welcome.id = "welcome";
    welcome.innerHTML = `
      <div class="welcome-logo"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 11a7 7 0 0 1-14 0"/><line x1="12" y1="18" x2="12" y2="22"/></svg></div>
      <h1>Como posso ajudar?</h1>
      <p class="welcome-sub">Envie mensagens, anexe imagens para leitura inteligente, gere imagens, crie arquivos e ouça as respostas em voz alta.</p>
      <div class="suggestions" id="suggestions">
        <button class="chip" data-q="Resuma em 3 tópicos as principais vantagens de aprender Python.">Aprender Python</button>
        <button class="chip" data-q="Escreva uma função em Python que retorna o n-ésimo termo de Fibonacci.">Código Python</button>
        <button class="chip" data-q="Crie um arquivo CSV com um plano de estudos semanal.">Criar arquivo CSV</button>
        <button class="chip" data-q="Gere uma imagem de um gato astronauta no espaço, estilo digital art.">Gerar imagem</button>
      </div>`;
    messagesEl.appendChild(welcome);
    resetComposer();
    updateSendBtn();
    inputEl.focus();
  });

  /* ---------------- Init ---------------- */
  updateSendBtn();
  inputEl.focus();
})();
