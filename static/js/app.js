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
  if (window.speechSynthesis) {
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
  function ttsSpeak(text) {
    if (!ttsEnabled || !window.speechSynthesis) return;
    ttsQueue.push(text);
    processTtsQueue();
  }
  function ttsStopAll() {
    ttsQueue = [];
    if (window.speechSynthesis && currentUtterance) {
      speechSynthesis.cancel();
      currentUtterance = null;
    }
    ttsSpeaking = false;
  }

  ttsToggle.addEventListener("change", () => {
    ttsEnabled = ttsToggle.checked;
    if (!ttsEnabled) ttsStopAll();
  });

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
  attachBtn.addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      attachedImage = { dataUrl: e.target.result, name: file.name };
      renderImagePreview();
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

  /* ---------------- Voice input (Web Speech Recognition) ---------------- */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recorder = null;
  let recording = false;

  function setRecording(state) {
    recording = state;
    micBtn.classList.toggle("recording", state);
    micBtn.title = state ? "Parar ditado" : "Falar (ditado por voz)";
  }

  micBtn.addEventListener("click", () => {
    if (recording) { if (recorder) recorder.stop(); return; }
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
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, image: image ? image.dataUrl : null, history }),
        signal: controller.signal,
      });

      if (!resp.ok || !resp.body) {
        throw new Error("Falha na comunicação com o servidor (HTTP " + resp.status + ")");
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let done = false;

      while (true) {
        const { done: rd, value } = await reader.read();
        if (rd) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop();
        for (const part of parts) {
          const trimmed = part.trim();
          if (!trimmed.startsWith("data:")) continue;
          let evt;
          try { evt = JSON.parse(trimmed.slice(5).trim()); } catch { continue; }
          if (evt.type === "delta") {
            assistant.raw += evt.content;
            setBubbleHTML(assistant, assistant.raw);
            if (assistant.ttsOn) {
              sentenceBuffer.text += evt.content;
              flushSentences();
            }
          } else if (evt.type === "done") {
            done = true;
          } else if (evt.type === "error") {
            assistant.bubble.classList.add("err-bubble");
            assistant.raw += "\n\nErro: " + evt.content;
            done = true;
          }
        }
      }
      if (sentenceBuffer.text.trim()) {
        ttsSpeak(sentenceBuffer.text.trim());
        sentenceBuffer.text = "";
      }
      finalizeBubble(assistant);
      assistant.streaming = false;
      if (!done && assistant.raw) {
        // resposta final mesmo sem evento done explícito
      }
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
