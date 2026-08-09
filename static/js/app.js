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

  let history = [];
  let attachedImage = null; // { dataUrl, name }
  let busy = false;
  let currentAssistant = null; // { row, bubble, raw }
  let streamAbort = null;

  /* ---------------- Native (APK Android) vs Web (Flask) ---------------- */
  const IS_NATIVE = !!window.AndroidBridge;
  let NATIVE_CONFIG = { apiKey: "", model: "llama-3.3-70b-versatile" };

  if (IS_NATIVE) {
    fetch("config.json")
      .then((r) => r.json())
      .then((c) => { NATIVE_CONFIG = c; })
      .catch(() => {});
    voiceSelect.style.display = "none";
  }

  function nativeGroqMessages(text, image, ocrText) {
    const msgs = [
      {
        role: "system",
        content:
          "Você é um assistente pessoal inteligente, amigável e preciso. " +
          "Responda SEMPRE em português do Brasil, de forma clara e objetiva. " +
          "Quando o usuário anexar uma imagem, o texto extraído dela via OCR será " +
          "fornecido no contexto — use-o para responder perguntas sobre o conteúdo. " +
          "Formate respostas com Markdown quando fizer sentido.",
      },
      ...history,
    ];
    let content = text || "Analise o conteúdo desta imagem e descreva o que você enxerga.";
    if (ocrText) content += "\n\nTexto extraído da imagem (OCR):\n" + ocrText;
    msgs.push({ role: "user", content });
    return msgs;
  }

  /* ---------------- Markdown ---------------- */
  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function renderMarkdown(md) {
    const esc = escapeHtml(md);
    if (window.marked) return marked.parse(esc);
    return esc.replace(/\n/g, "<br>");
  }
  function setBubbleHTML(assistant, text) {
    assistant.bubble.innerHTML = renderMarkdown(text) + `<span class="caret"></span>`;
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  function finalizeBubble(assistant) {
    if (assistant.bubble.querySelector(".caret")) {
      assistant.bubble.innerHTML = renderMarkdown(assistant.raw);
    }
  }

  /* ---------------- Native TTS (voz nativa do aparelho) ---------------- */
  let ttsEnabled = ttsToggle.checked;
  let ttsQueue = [];
  let ttsSpeaking = false;
  let currentUtterance = null;

  function ttsSpeak(text) {
    if (!ttsEnabled) return;
    if (!text.trim()) return;
    if (IS_NATIVE) {
      window.AndroidBridge.speak(text);
      return;
    }
    if (!window.speechSynthesis) return;
    ttsQueue.push(text);
    processTtsQueue();
  }
  function ttsStopAll() {
    ttsQueue = [];
    ttsSpeaking = false;
    currentUtterance = null;
    if (IS_NATIVE) {
      window.AndroidBridge.stopSpeak();
      return;
    }
    if (window.speechSynthesis) speechSynthesis.cancel();
  }
  function ttsApplyRate(rate) {
    if (IS_NATIVE) {
      window.AndroidBridge.setRate(rate);
      return;
    }
    if (window.speechSynthesis) speechSynthesis.cancel();
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
      bubble.innerHTML += `<span class="ocr-tag">Imagem · leitura via OCR</span>`;
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
    const assistant = { row, bubble: row.querySelector(".bubble"), raw: "", streaming: true, ttsOn: true };
    attachSpeakAction(assistant);
    return assistant;
  }

  function attachSpeakAction(assistant) {
    const actions = assistant.row.querySelector(".actions");
    if (!actions) return;
    const btn = document.createElement("button");
    btn.className = "speak-btn";
    btn.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3z"/><path d="M16.5 12a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z"/></svg> Narrar`;
    btn.addEventListener("click", () => {
      if (!ttsEnabled && window.confirm("A narração está desligada. Ativar?")) {
        ttsToggle.checked = true;
        ttsEnabled = true;
      }
      ttsStopAll();
      ttsSpeak(assistant.raw);
    });
    actions.appendChild(btn);
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
  function applyDelta(assistant, content) {
    assistant.raw += content;
    setBubbleHTML(assistant, assistant.raw);
    if (assistant.ttsOn) {
      sentenceBuffer.text += content;
      flushSentences();
    }
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
        const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + NATIVE_CONFIG.apiKey,
          },
          body: JSON.stringify({
            model: NATIVE_CONFIG.model || "llama-3.3-70b-versatile",
            messages: nativeGroqMessages(text, image, nativeOcrResult),
            stream: true,
            temperature: 0.7,
            max_tokens: 2048,
          }),
          signal: controller.signal,
        });
        if (!resp.ok || !resp.body) {
          throw new Error("Erro da API Groq (HTTP " + resp.status + ")");
        }
        await consumeStream(
          resp.body,
          (raw) => {
            let evt;
            try { evt = JSON.parse(raw); } catch { return; }
            let content = null;
            if (evt.type === "delta") content = evt.content;
            else if (evt.choices && evt.choices[0] && evt.choices[0].delta) {
              content = evt.choices[0].delta.content;
            }
            if (content) applyDelta(assistant, content);
          },
          () => {}
        );
      } else {
        const resp = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text, image: image ? image.dataUrl : null, history }),
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
      if (assistant.raw) history.push({ role: "assistant", content: assistant.raw });
    } catch (err) {
      if (err.name === "AbortError") {
        if (sentenceBuffer.text.trim()) { ttsSpeak(sentenceBuffer.text.trim()); sentenceBuffer.text = ""; }
        finalizeBubble(assistant);
        assistant.bubble.classList.add("err-bubble");
        if (assistant.raw) assistant.raw += "\n\n_[resposta interrompida]_";
        if (assistant.raw) history.push({ role: "assistant", content: assistant.raw });
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
      <p class="welcome-sub">Digite uma mensagem, anexe uma imagem para leitura via OCR ou use o microfone.</p>
      <div class="suggestions" id="suggestions">
        <button class="chip" data-q="Resuma em 3 tópicos as principais vantagens de aprender Python.">Aprender Python</button>
        <button class="chip" data-q="Escreva uma função em Python que retorna o n-ésimo termo de Fibonacci.">Código Python</button>
        <button class="chip" data-q="Explique o que é machine learning de forma simples.">Machine learning</button>
        <button class="chip" data-q="Crie um roteiro de estudos de 4 semanas para front-end.">Roteiro de estudos</button>
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
