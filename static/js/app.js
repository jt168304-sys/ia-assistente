(() => {
  "use strict";

  const messagesEl = document.getElementById("messages");
  const welcomeEl = document.getElementById("welcome");
  const inputEl = document.getElementById("input");
  const sendBtn = document.getElementById("sendBtn");
  const micBtn = document.getElementById("micBtn");
  const attachBtn = document.getElementById("attachBtn");
  const imageBtn = document.getElementById("imageBtn");
  const fileInput = document.getElementById("fileInput");
  const previewEl = document.getElementById("imagePreview");
  const newChatBtn = document.getElementById("newChatBtn");
  const ttsToggle = document.getElementById("ttsToggle");
  const voiceSelect = document.getElementById("voiceSelect");
  const rateSelect = document.getElementById("rateSelect");

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
    imageApi: "https://image.pollinations.ai/prompt/",
  };

  if (IS_NATIVE) {
    try {
      const raw = window.AndroidBridge.getConfig();
      if (raw) NATIVE_CONFIG = Object.assign({}, NATIVE_CONFIG, JSON.parse(raw));
    } catch (e) { /* ignore */ }
    fetch("config.json")
      .then((r) => r.json())
      .then((c) => { NATIVE_CONFIG = Object.assign({}, NATIVE_CONFIG, c); })
      .catch(() => {});
    voiceSelect.style.display = "none";
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
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

  function addDownloadImageAction(assistant, url, name) {
    const actions = assistant.row.querySelector(".actions");
    if (!actions) return;
    const b = document.createElement("button");
    b.className = "speak-btn";
    b.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0l-4-4m4 4l4-4"/><path d="M4 21h16"/></svg> Baixar imagem`;
    b.addEventListener("click", () => {
      if (IS_NATIVE) {
        window.AndroidBridge.downloadImage(url, name);
        toast("Baixando imagem: " + name);
      } else {
        window.open(url, "_blank");
      }
    });
    actions.appendChild(b);
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

  /* ---------------- Voice input (Web Speech Recognition / bridge nativo) ---------------- */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recorder = null;
  let recording = false;

  function setRecording(state) {
    recording = state;
    micBtn.classList.toggle("recording", state);
    micBtn.title = state ? "Parar ditado" : "Falar (ditado por voz)";
  }

  window.onVoiceResult = (text) => {
    setRecording(false);
    if (text) {
      inputEl.value = text;
      autoResize();
      updateSendBtn();
    }
  };
  window.onVoiceError = (msg) => {
    setRecording(false);
    alert("Erro no microfone: " + msg);
  };

  micBtn.addEventListener("click", () => {
    if (recording) {
      if (recorder) recorder.stop();
      return;
    }
    if (IS_NATIVE) {
      window.AndroidBridge.startRecognition();
      setRecording(true);
      return;
    }
    if (!SR) {
      alert("Reconhecimento de voz não suportado neste navegador. Use o Chrome no Android ou no desktop.");
      return;
    }
    try {
      recorder = new SR();
      recorder.lang = (pickVoice() && pickVoice().lang) || "pt-BR";
      recorder.interimResults = true;
      recorder.continuous = true;
      setRecording(true);
      recorder.onresult = (e) => {
        let t = "";
        for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
        inputEl.value = t;
        autoResize();
      };
      recorder.onend = () => setRecording(false);
      recorder.onerror = (e) => {
        setRecording(false);
        if (e.error && e.error !== "aborted" && e.error !== "no-speech") {
          alert("Erro no microfone: " + e.error);
        }
      };
      recorder.start();
    } catch (err) {
      setRecording(false);
      alert("Não foi possível iniciar o microfone: " + err.message);
    }
  });

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

  async function groqStream(model, messages, controller, onLine, maxTokens) {
    const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + NATIVE_CONFIG.apiKey,
      },
      body: JSON.stringify({
        model: model,
        messages: messages,
        stream: true,
        temperature: 0.7,
        max_tokens: maxTokens || 1500,
        ...reasoningParam(model),
      }),
      signal: controller.signal,
    });
    if (!resp.ok || !resp.body) {
      throw new Error("Erro da API Groq (HTTP " + resp.status + ")");
    }
    await consumeStream(resp.body, (raw) => {
      const c = parseDelta(raw);
      if (c) onLine(c);
    }, () => {});
  }

  async function groqNonStream(messages, maxTokens) {
    const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + NATIVE_CONFIG.apiKey,
      },
      body: JSON.stringify({
        model: NATIVE_CONFIG.model,
        messages: messages,
        temperature: 0.7,
        max_tokens: maxTokens || 300,
        ...reasoningParam(NATIVE_CONFIG.model),
      }),
    });
    if (!resp.ok) throw new Error("Erro da API Groq (HTTP " + resp.status + ")");
    const j = await resp.json();
    return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
  }

  async function enhanceImagePrompt(prompt, context) {
    try {
      const userContent = context
        ? prompt +
          "\n\nResultados de pesquisa na web sobre o assunto. Use-os APENAS se ajudarem " +
          "a descrever o que o usuário pediu (ex.: aparência real de um personagem, objeto " +
          "ou lugar). Ignore resultados irrelevantes:\n" +
          context
        : prompt;
      const out = await groqNonStream([
        {
          role: "system",
          content:
            "You are an expert image prompt engineer. Convert the user's request into a " +
            "detailed English prompt for an AI image generator. " +
            "CRITICAL RULE: reproduce the user's scene EXACTLY. If the user says " +
            "'one banana on a wooden table', the prompt MUST contain a realistic single " +
            "banana resting on a real wooden table, with no other objects added and no " +
            "fantastical reinterpretation. Never change the subject, never add creatures, " +
            "never invent species, never replace the background object the user named. If " +
            "web reference describes a real person/character/object, use those REAL details " +
            "(hair, clothes, colors, props) so the image looks like the actual thing. " +
            "Keep every element the user mentioned and only add generic style/quality words " +
            "(photorealistic, natural lighting, sharp focus, high detail, professional " +
            "photography). Reply ONLY with the English prompt, without quotes or extra text.",
        },
        { role: "user", content: userContent },
      ], 400);
      return out.trim() || prompt;
    } catch (e) {
      return prompt;
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
        currentDateTime() + ". Use isso para perguntas sobre data e hora. " +
        "Quando o usuário anexar uma imagem, o texto extraído dela via OCR será " +
        "fornecido no contexto — use-o para responder perguntas sobre o conteúdo. " +
        "Formate respostas com Markdown quando fizer sentido. Prefira hífens (-) em listas " +
        "em vez de asteriscos, e evite asteriscos de ênfase (*texto*) para que a narração " +
        "por voz saia limpa. Quando o usuário pedir para criar um arquivo, entregue o " +
        "conteúdo completo dentro de um bloco de código.",
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

  function slugify(s) {
    return (s || "imagem")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "imagem";
  }

  function trimHistory(arr, n) {
    if (!arr || arr.length <= n) return arr;
    return arr.slice(arr.length - n);
  }

  async function nativeWebSearch(query) {
    try {
      const raw = window.AndroidBridge.webSearch(query);
      const list = JSON.parse(raw || "[]");
      const lines = list.slice(0, 5).map(
        (r, i) => `${i + 1}. ${r.title || ""}\n   URL: ${r.url || ""}\n   ${(r.snippet || "").slice(0, 220)}`
      );
      return lines.join("\n\n");
    } catch (e) {
      return "";
    }
  }

  function injectSearchContext(messages, context) {
    if (!context) return messages;
    const hint =
      "Resultados de pesquisa na web sobre a pergunta do usuário. Use-os para dar " +
      "informações atuais e cite as fontes quando útil:";
    const msgs = messages.slice();
    msgs.splice(msgs.length - 1, 0, { role: "system", content: hint + "\n\n" + context });
    return msgs;
  }

  async function send() {
    const text = inputEl.value.trim();
    const image = attachedImage;
    if (busy) {
      if (streamAbort) streamAbort.abort();
      busy = false;
      updateSendBtn();
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
        if (!NATIVE_CONFIG.apiKey || NATIVE_CONFIG.apiKey === "CHAVE_NAO_CONFIGURADA") {
          throw new Error("APK sem chave de API. Configure o secret GROQ_API_KEY no repositório e recompile.");
        }
        if (nativeOcrPending) {
          const t0 = Date.now();
          while (nativeOcrPending && Date.now() - t0 < 20000) {
            await new Promise((r) => setTimeout(r, 50));
          }
        }
        const hasVision = !!(image && NATIVE_CONFIG.visionModel && NATIVE_CONFIG.visionModel.toLowerCase() !== "none");
        let searchContext = "";
        if (text) {
          searchContext = await nativeWebSearch(text);
        }
        try {
          if (hasVision) {
            await groqStream(
              NATIVE_CONFIG.visionModel,
              injectSearchContext(nativeVisionMessages(text, image.dataUrl, nativeOcrResult), searchContext),
              controller,
              (c) => applyDelta(assistant, c)
            );
          } else {
            await groqStream(
              NATIVE_CONFIG.model,
              injectSearchContext(nativeGroqMessages(text, image, nativeOcrResult), searchContext),
              controller,
              (c) => applyDelta(assistant, c)
            );
          }
        } catch (visionErr) {
          if (hasVision && nativeOcrResult) {
            assistant.raw = "";
            assistant.displayLen = 0;
            assistant.bubble.innerHTML = `<span class="typing"><span></span><span></span><span></span></span>`;
            await groqStream(
              NATIVE_CONFIG.model,
              injectSearchContext(nativeGroqMessages(text, image, nativeOcrResult), searchContext),
              controller,
              (c) => applyDelta(assistant, c)
            );
          } else {
            throw visionErr;
          }
        }
      } else {
        const resp = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text, image: image ? image.dataUrl : null, history: trimHistory(history, 12), search: true }),
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
      if (sentenceBuffer.text.trim()) {
        ttsSpeak(sentenceBuffer.text.trim());
        sentenceBuffer.text = "";
      }
      finalizeBubble(assistant);
      assistant.streaming = false;
      attachActions(assistant);
        if (assistant.raw) history.push({ role: "assistant", content: stripThink(assistant.raw) });
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
    }
  }

  sendBtn.addEventListener("click", send);
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  inputEl.addEventListener("input", updateSendBtn);

  /* ---------------- Image generation ---------------- */
  let imageBusy = false;

  function setImageBusy(state) {
    imageBusy = state;
    imageBtn.classList.toggle("busy", state);
    imageBtn.title = state ? "Gerando imagem..." : "Gerar imagem (use o texto digitado como prompt)";
  }

  imageBtn.addEventListener("click", generateImage);

  async function generateImage() {
    if (imageBusy) return;
    let prompt = inputEl.value.trim();
    if (!prompt) {
      prompt = window.prompt("Descreva a imagem que deseja gerar:");
    }
    if (!prompt) return;
    const welcome = document.getElementById("welcome");
    if (welcome) welcome.remove();
    resetComposer();

    setImageBusy(true);
    const assistant = addAssistantMessage();
    assistant.bubble.innerHTML = `<span class="typing"><span></span><span></span><span></span></span> <span class="gen-label">Gerando imagem...</span>`;

    try {
      let url;
      if (IS_NATIVE) {
        if (!NATIVE_CONFIG.apiKey || NATIVE_CONFIG.apiKey === "CHAVE_NAO_CONFIGURADA") {
          throw new Error("APK sem chave de API. Configure o secret GROQ_API_KEY no repositório e recompile.");
        }
        const searchRef = await nativeWebSearch(prompt);
        const enhanced = await enhanceImagePrompt(prompt, searchRef);
        const base = NATIVE_CONFIG.imageApi || "https://image.pollinations.ai/prompt/";
        const seed = Math.floor(Math.random() * 999999) + 1;
        url = `${base.replace(/\/+$/, "")}/${encodeURIComponent(enhanced)}?width=896&height=1024&seed=${seed}&nologo=true&model=flux&enhance=true`;
      } else {
        const resp = await fetch("/api/image", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt }),
        });
        let j = {};
        try { j = await resp.json(); } catch (e) { /* ignore */ }
        if (!resp.ok || !j.url) throw new Error(j.error || "HTTP " + resp.status);
        url = j.url;
      }

      assistant.bubble.innerHTML = `
        <div class="img-gen">
          <div class="gen-loading"><span class="typing"><span></span><span></span><span></span></span> Aguardando a imagem...</div>
          <img class="gen-img" src="${escapeHtml(url)}" alt="${escapeHtml(prompt)}" loading="lazy">
          <div class="img-meta">${escapeHtml(prompt)}</div>
        </div>`;
      const img = assistant.bubble.querySelector(".gen-img");
      img.onload = () => {
        const ld = assistant.bubble.querySelector(".gen-loading");
        if (ld) ld.remove();
        messagesEl.scrollTop = messagesEl.scrollHeight;
      };
      img.onerror = () => {
        const ld = assistant.bubble.querySelector(".gen-loading");
        if (ld) ld.remove();
        assistant.bubble.classList.add("err-bubble");
        assistant.bubble.innerHTML = `<span class="err-bubble">Não foi possível carregar a imagem gerada.</span>`;
      };
      assistant.raw = `![${prompt}](${url})`;
      assistant.streaming = false;
      addDownloadImageAction(assistant, url, "imagem-" + slugify(prompt) + ".jpg");
    } catch (err) {
      assistant.bubble.innerHTML = `<span class="err-bubble">Erro ao gerar imagem: ${escapeHtml(err.message)}</span>`;
    } finally {
      setImageBusy(false);
    }
  }

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
        <button class="chip" data-q="Explique o que é machine learning de forma simples.">Machine learning</button>
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
