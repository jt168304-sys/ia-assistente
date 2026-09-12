import base64
import io
import json
import os
import random
import re
import time
import urllib.parse
import urllib.request
from datetime import datetime

from dotenv import load_dotenv
from flask import Flask, Response, jsonify, render_template, request, send_from_directory, stream_with_context
from groq import Groq
from PIL import Image
import pytesseract

load_dotenv()

app = Flask(__name__)

GROQ_API_KEY = os.getenv("GROQ_API_KEY", "").strip()
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "").strip()
LLM_PROVIDER = os.getenv("LLM_PROVIDER", "auto").strip().lower() or "auto"

GROQ_MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")
VISION_MODEL = os.getenv("GROQ_VISION_MODEL", "qwen/qwen3.6-27b").strip()
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.0-flash")
OPENROUTER_MODEL = os.getenv("OPENROUTER_MODEL", "meta-llama/llama-3.3-70b-instruct:free")

OCR_LANG = os.getenv("OCR_LANG", "por+eng")
MAX_IMAGE_DIM = 1600
IMAGE_API_URL = os.getenv("IMAGE_API_URL", "https://image.pollinations.ai/prompt/").rstrip("/") + "/"
IMAGE_MODEL = os.getenv("IMAGE_MODEL", "flux")

groq_client = Groq(api_key=GROQ_API_KEY) if GROQ_API_KEY else None

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


def reasoning_param(model):
    m = (model or "").lower()
    if "qwen" in m:
        return {"reasoning_effort": "none"}
    if "gpt-oss" in m:
        return {"reasoning_effort": "low"}
    return {}


SYSTEM_PROMPT = (
    "Você é um assistente pessoal inteligente, amigável e preciso, chamado YuIA. "
    "Responda SEMPRE em português do Brasil (pt-BR), de forma clara, objetiva e completa. "
    "Regra rígida: jamais responda em inglês, espanhol ou outro idioma — escreva tudo em "
    "português, mesmo quando o usuário escrever em outro idioma (entenda e responda em pt-BR). "
    "Termos técnicos, nomes de bibliotecas e comandos podem ficar em inglês, mas a explicação "
    "e o texto ao redor sempre em português. "
    "Seja CONCISO: responda de forma direta e enxuta, sem introduções longas, sem repetição "
    "e sem desabafar. Prefira respostas curtas (2 a 5 parágrafos no máximo, ou listas curtas "
    "com poucos itens). Não enumere tudo o que sabe — responda apenas o que foi perguntado. "
    "Você pode receber imagens: analise-as diretamente (visão) e use o texto de OCR "
    "fornecido como contexto auxiliar quando presente. Ao descrever uma imagem, fale sempre "
    "em português do Brasil. "
    "Formate respostas com Markdown quando fizer sentido (listas, tabelas, trechos de código). "
    "Prefira hífens (-) para listas em vez de asteriscos, e evite asteriscos de ênfase "
    "(*texto*) para que a narração por voz saia limpa. "
    "Quando o usuário pedir para criar um arquivo, um script, uma planilha CSV, um JSON, "
    "um HTML, um Markdown ou qualquer documento, gere o conteúdo completo dentro de um bloco de código "
    "delimitado por ``` com a linguagem indicada (ex.: ```python, ```csv, ```json, ```html). "
    "Assim o app permite baixar o arquivo. Seja criativo e proativo: ofereça exemplos, "
    "códigos, planos e formatos úteis. Sempre que fizer sentido, entregue o conteúdo "
    "pronto para uso e download. "
    "Se o usuário pedir uma imagem, descreva o que será gerado de forma breve; a geração "
    "visual é feita pelo motor de imagens do app. "
    "NUNCA invente informações. Se você não souber ou não tiver certeza, diga claramente "
    "que não sabe ou que não encontrou a informação — jamais invente fatos, URLs, números, "
    "nomes de vídeos, canais, obras, autores ou dados para parecer útil. Responda apenas "
    "com base no que você realmente sabe ou nos resultados de pesquisa fornecidos no "
    "contexto. "
    "Recuse apenas pedidos claramente ilegais (crime, exploração de menores, armas, "
    "ataques). Para o restante, seja útil, direto e honesto."
)


def build_system_prompt():
    now = datetime.now()
    try:
        tz = time.tzname[0] or ""
    except Exception:
        tz = ""
    info = (
        f"\n\nData e hora atuais: hoje é {now.strftime('%d/%m/%Y')} e agora são "
        f"{now.strftime('%H:%M')} (horário do servidor, fuso {tz}). "
        "Use essa informação quando o usuário perguntar que dia é hoje, que horas são, "
        "qual a data de um evento futuro, etc."
    )
    return SYSTEM_PROMPT + info


def ocr_from_data_url(data_url):
    header, _, b64 = data_url.partition(",")
    raw = base64.b64decode(b64)
    img = Image.open(io.BytesIO(raw))
    if img.mode in ("RGBA", "P", "LA"):
        img = img.convert("RGB")
    img.thumbnail((MAX_IMAGE_DIM, MAX_IMAGE_DIM))
    return pytesseract.image_to_string(img, lang=OCR_LANG)


def http_get(url, timeout=10, accept="*/*"):
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept": accept,
            "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def http_json(url, timeout=10):
    return json.loads(http_get(url, timeout=timeout, accept="application/json").decode("utf-8", "replace"))


def available_providers():
    out = []
    if GROQ_API_KEY:
        out.append("groq")
    if GEMINI_API_KEY:
        out.append("gemini")
    if OPENROUTER_API_KEY:
        out.append("openrouter")
    return out


def resolve_providers(requested):
    req = (requested or LLM_PROVIDER or "auto").strip().lower()
    have = available_providers()
    if req in have:
        rest = [p for p in have if p != req]
        return [req] + rest
    return have


def provider_model(name, vision=False):
    if name == "groq":
        if vision and VISION_MODEL and VISION_MODEL.lower() != "none":
            return VISION_MODEL
        return GROQ_MODEL
    if name == "gemini":
        return GEMINI_MODEL
    if name == "openrouter":
        return OPENROUTER_MODEL
    return GROQ_MODEL


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/css/<path:filename>")
def css(filename):
    return send_from_directory("static/css", filename)


@app.get("/js/<path:filename>")
def js(filename):
    return send_from_directory("static/js", filename)


@app.get("/api/health")
def health():
    providers = available_providers()
    return jsonify(
        {
            "status": "ok",
            "providers": providers,
            "provider": LLM_PROVIDER,
            "model": GROQ_MODEL,
            "gemini_model": GEMINI_MODEL,
            "openrouter_model": OPENROUTER_MODEL,
            "vision_model": VISION_MODEL if VISION_MODEL and VISION_MODEL.lower() != "none" else None,
            "image_model": IMAGE_MODEL,
        }
    )


def build_messages(system_prompt, history, text, ocr_text, image_data_url):
    messages = [{"role": "system", "content": system_prompt}]
    messages.extend(history)

    use_vision = bool(image_data_url)

    if use_vision:
        parts = []
        if text:
            parts.append({"type": "text", "text": text})
        else:
            parts.append({"type": "text", "text": "Analise esta imagem e descreva detalhadamente o que você enxerga."})
        parts.append({"type": "image_url", "image_url": {"url": image_data_url}})
        if ocr_text:
            parts.append({"type": "text", "text": f"Texto extraído por OCR (contexto auxiliar):\n{ocr_text}"})
        messages.append({"role": "user", "content": parts})
    else:
        user_content = text
        if image_data_url:
            if not user_content:
                user_content = "Analise o conteúdo desta imagem e descreva o que você enxerga."
            if ocr_text:
                user_content += f"\n\nTexto extraído da imagem (OCR):\n{ocr_text}"
        messages.append({"role": "user", "content": user_content})

    return messages, use_vision


def _sse(obj):
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"


def stream_groq(messages, model, max_tokens):
    stream = groq_client.chat.completions.create(
        model=model,
        messages=messages,
        stream=True,
        temperature=0.7,
        max_tokens=max_tokens,
        **reasoning_param(model),
    )
    for chunk in stream:
        delta = chunk.choices[0].delta.content
        if delta:
            yield delta


def _compat_headers(api_key):
    return {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
        "User-Agent": UA,
        "Accept": "text/event-stream",
    }


def stream_openai_compat(url, api_key, model, messages, max_tokens, extra_headers=None):
    payload = json.dumps(
        {
            "model": model,
            "messages": messages,
            "stream": True,
            "temperature": 0.7,
            "max_tokens": max_tokens,
        }
    ).encode("utf-8")
    headers = _compat_headers(api_key)
    if extra_headers:
        headers.update(extra_headers)
    req = urllib.request.Request(url, data=payload, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=90) as resp:
        buf = b""
        while True:
            chunk = resp.read(256)
            if not chunk:
                break
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                text = line.decode("utf-8", "replace").strip()
                if not text.startswith("data:"):
                    continue
                raw = text[5:].strip()
                if not raw or raw == "[DONE]":
                    continue
                try:
                    evt = json.loads(raw)
                except Exception:
                    continue
                try:
                    delta = evt["choices"][0]["delta"].get("content")
                except Exception:
                    delta = None
                if delta:
                    yield delta


def stream_gemini(messages, model, max_tokens):
    url = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
    yield from stream_openai_compat(url, GEMINI_API_KEY, model, messages, max_tokens)


def stream_openrouter(messages, model, max_tokens):
    url = "https://openrouter.ai/api/v1/chat/completions"
    extra = {
        "HTTP-Referer": "https://github.com/jt168304-sys/ia-assistente",
        "X-Title": "YuIA",
    }
    yield from stream_openai_compat(url, OPENROUTER_API_KEY, model, messages, max_tokens, extra)


def iter_provider_tokens(name, messages, vision, max_tokens):
    model = provider_model(name, vision=vision)
    if name == "groq":
        if not groq_client:
            raise RuntimeError("Groq sem chave")
        yield from stream_groq(messages, model, max_tokens)
        return
    if name == "gemini":
        if not GEMINI_API_KEY:
            raise RuntimeError("Gemini sem chave")
        yield from stream_gemini(messages, model, max_tokens)
        return
    if name == "openrouter":
        if not OPENROUTER_API_KEY:
            raise RuntimeError("OpenRouter sem chave")
        yield from stream_openrouter(messages, model, max_tokens)
        return
    raise RuntimeError("provedor desconhecido")


def complete_text(messages, max_tokens=400):
    last_err = None
    for name in resolve_providers("auto"):
        model = provider_model(name, vision=False)
        try:
            if name == "groq" and groq_client:
                resp = groq_client.chat.completions.create(
                    model=model,
                    messages=messages,
                    temperature=0.4,
                    max_tokens=max_tokens,
                    **reasoning_param(model),
                )
                return (resp.choices[0].message.content or "").strip()
            chunks = []
            if name == "gemini":
                for t in stream_gemini(messages, model, max_tokens):
                    chunks.append(t)
            elif name == "openrouter":
                for t in stream_openrouter(messages, model, max_tokens):
                    chunks.append(t)
            text = "".join(chunks).strip()
            if text:
                return text
        except Exception as exc:
            last_err = exc
            continue
    if last_err:
        raise last_err
    return ""


def stream_chat(messages, providers, vision=False, max_tokens=1500):
    def generate():
        last_err = None
        for name in providers:
            got = False
            try:
                for delta in iter_provider_tokens(name, messages, vision, max_tokens):
                    got = True
                    yield _sse({"type": "delta", "content": delta, "provider": name})
                yield _sse({"type": "done", "provider": name})
                return
            except Exception as exc:
                last_err = exc
                if got:
                    yield _sse({"type": "error", "content": str(exc)})
                    return
                continue
        msg = str(last_err) if last_err else "Nenhum provedor de IA configurado"
        yield _sse({"type": "error", "content": msg})

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


_search_cache = {}
_SEARCH_TTL = 10 * 60


def _clean_html(s):
    t = re.sub(r"<[^>]+>", "", s or "")
    t = (
        t.replace("&amp;", "&")
        .replace("&quot;", '"')
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ")
    )
    return re.sub(r"\s+", " ", t).strip()


def _wikipedia_search(query, lang="pt", max_results=5):
    host = "pt.wikipedia.org" if lang == "pt" else "en.wikipedia.org"
    url = (
        f"https://{host}/w/api.php?action=query&list=search&srsearch="
        + urllib.parse.quote(query)
        + f"&srlimit={max_results}&format=json&utf8=1"
    )
    data = http_json(url, timeout=8)
    out = []
    for r in data.get("query", {}).get("search", [])[:max_results]:
        title = (r.get("title") or "").strip()
        snippet = _clean_html(r.get("snippet") or "")
        page_url = f"https://{host}/wiki/" + urllib.parse.quote(title.replace(" ", "_"))
        out.append({"title": title, "href": page_url, "body": snippet})
    return out


def _ddg_instant(query):
    url = (
        "https://api.duckduckgo.com/?q="
        + urllib.parse.quote(query)
        + "&format=json&no_html=1&skip_disambig=1"
    )
    data = http_json(url, timeout=8)
    out = []
    abstract = (data.get("AbstractText") or "").strip()
    abs_url = (data.get("AbstractURL") or "").strip()
    heading = (data.get("Heading") or data.get("AbstractSource") or "DuckDuckGo").strip()
    if abstract:
        out.append({"title": heading, "href": abs_url, "body": abstract[:400]})
    answer = (data.get("Answer") or "").strip()
    if answer:
        out.append({"title": heading or "Resposta", "href": abs_url, "body": _clean_html(answer)[:400]})
    for item in data.get("RelatedTopics") or []:
        if len(out) >= 5:
            break
        if not isinstance(item, dict):
            continue
        if "Topics" in item:
            continue
        text = (item.get("Text") or "").strip()
        href = (item.get("FirstURL") or "").strip()
        if text:
            out.append({"title": text.split(" - ", 1)[0][:80], "href": href, "body": text[:300]})
    return out


def _ddg_lite(query, max_results=5):
    url = "https://lite.duckduckgo.com/lite/?q=" + urllib.parse.quote(query)
    html = http_get(url, timeout=10, accept="text/html").decode("utf-8", "replace")
    out = []
    seen = set()
    for m in re.finditer(r'<a[^>]+href="(https?://[^"]+)"[^>]*>(.*?)</a>', html, re.I | re.S):
        href = m.group(1)
        if "duckduckgo.com" in href or href in seen:
            continue
        title = _clean_html(m.group(2))
        if not title or len(title) < 3:
            continue
        seen.add(href)
        out.append({"title": title, "href": href, "body": ""})
        if len(out) >= max_results:
            break
    return out


def _ddgs_lib(query, max_results=5):
    from ddgs import DDGS

    results = []
    with DDGS() as ddgs:
        try:
            results = list(ddgs.text(query, region="br-pt", max_results=max_results))
        except Exception:
            results = list(ddgs.text(query, max_results=max_results))
    out = []
    for r in results:
        out.append(
            {
                "title": (r.get("title") or "").strip(),
                "href": (r.get("href") or r.get("url") or "").strip(),
                "body": (r.get("body") or r.get("snippet") or "").strip(),
            }
        )
    return out


def _merge_results(base, extra):
    seen = {(r.get("href") or "").rstrip("/") for r in base}
    for r in extra:
        href = (r.get("href") or "").rstrip("/")
        if href and href in seen:
            continue
        if href:
            seen.add(href)
        if (r.get("title") or r.get("body")):
            base.append(r)
    return base


def web_search(query, max_results=5):
    if not query or not query.strip():
        return ""
    query = query.strip()

    cached = _search_cache.get(query)
    if cached and time.time() - cached[1] < _SEARCH_TTL:
        return cached[0]

    results = []
    sources = (
        _ddgs_lib,
        _ddg_instant,
        _ddg_lite,
        lambda q: _wikipedia_search(q, "pt", max_results),
        lambda q: _wikipedia_search(q, "en", max_results),
    )
    for fn in sources:
        if len(results) >= max_results:
            break
        try:
            extra = fn(query)
        except Exception:
            extra = []
        if extra:
            results = _merge_results(results, extra)

    results = results[:max_results]
    if not results:
        return ""

    lines = []
    for i, r in enumerate(results, 1):
        title = (r.get("title") or "").strip()
        href = (r.get("href") or "").strip()
        body = (r.get("body") or "").strip()
        if len(body) > 220:
            body = body[:220].rsplit(" ", 1)[0] + "..."
        lines.append(f"{i}. {title}\n   URL: {href}\n   {body}")
    text = "\n\n".join(lines)
    _search_cache[query] = (text, time.time())
    return text


def looks_like_image_request(text):
    t = (text or "").strip().lower()
    if not t:
        return False
    return bool(
        re.search(
            r"\b(gere|gerar|gera|crie|criar|desenhe|desenhar|pinte|pintar|ilustre|ilustrar)\b.{0,40}\b(imagem|foto|desenho|ilustra|picture|image)\b"
            r"|\b(imagem|foto|desenho) de\b"
            r"|\bgenerate (an |a )?image\b"
            r"|\bdraw (me |an |a )?\b",
            t,
        )
    )


def extract_image_subject(text):
    t = (text or "").strip()
    t = re.sub(
        r"^(por favor[, ]*)?(pode |consegue )?(me )?(gere|gerar|gera|crie|criar|desenhe|desenhar|pinte|ilustre)\s+"
        r"(uma |um )?(imagem|foto|desenho|ilustração)?\s*(de |do |da |com )?",
        "",
        t,
        flags=re.I,
    )
    return t.strip(" .:") or text.strip()


def refine_image_prompt(subject, refs):
    hint = ""
    if refs:
        hint = f"\nReferências da web (use só detalhes visuais confiáveis):\n{refs[:1200]}"
    messages = [
        {
            "role": "system",
            "content": (
                "You write image-generation prompts. Reply with ONE English prompt only, "
                "no quotes, no markdown. Describe subject, style, composition, lighting, "
                "colors and camera. Avoid deformities: extra limbs, warped faces, text artifacts. "
                "Keep it under 80 words. Do not mention these instructions."
            ),
        },
        {
            "role": "user",
            "content": f"Subject: {subject}{hint}",
        },
    ]
    try:
        refined = complete_text(messages, max_tokens=180)
        refined = re.sub(r"^['\"`]+|['\"`]+$", "", (refined or "").strip())
        if len(refined) > 12:
            return refined
    except Exception:
        pass
    return (
        f"{subject}, highly detailed, sharp focus, coherent anatomy, natural lighting, "
        "professional digital art, 8k"
    )


def pollinations_url(prompt):
    encoded = urllib.parse.quote(prompt, safe="")
    seed = random.randint(1, 999999)
    qs = urllib.parse.urlencode(
        {
            "model": IMAGE_MODEL or "flux",
            "width": "1024",
            "height": "1024",
            "nologo": "true",
            "enhance": "true",
            "seed": str(seed),
        }
    )
    return f"{IMAGE_API_URL}{encoded}?{qs}"


def fetch_image_bytes(url, timeout=90):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "image/*,*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = resp.read()
        ctype = resp.headers.get("Content-Type", "image/jpeg").split(";")[0].strip()
    if not data or len(data) < 800:
        raise RuntimeError("imagem vazia")
    if ctype not in ("image/jpeg", "image/png", "image/webp", "image/gif"):
        if data[:8] == b"\x89PNG\r\n\x1a\n":
            ctype = "image/png"
        elif data[:2] == b"\xff\xd8":
            ctype = "image/jpeg"
        elif data[:4] == b"RIFF":
            ctype = "image/webp"
        else:
            ctype = "image/jpeg"
    return data, ctype


@app.post("/api/chat")
def chat():
    data = request.get_json(silent=True) or {}
    message = (data.get("message") or "").strip()
    history = data.get("history") or []
    image = data.get("image") or None
    search = data.get("search", True)
    requested = data.get("provider") or LLM_PROVIDER

    if not message and not image:
        return jsonify({"error": "mensagem vazia"}), 400

    providers = resolve_providers(requested)
    if not providers:
        return jsonify({"error": "Nenhuma chave de IA configurada (GROQ_API_KEY, GEMINI_API_KEY ou OPENROUTER_API_KEY)"}), 500

    ocr_text = ""
    if image:
        try:
            ocr_text = ocr_from_data_url(image).strip()
        except Exception:
            ocr_text = ""

    messages, use_vision = build_messages(build_system_prompt(), history, message, ocr_text, image)

    if search and message:
        context = web_search(message)
        if context:
            hint = (
                "Resultados de pesquisa na web sobre a pergunta do usuário. Se a pergunta "
                "exigir informação externa ou atual, responda APENAS com base nesses "
                "resultados. Se a resposta não estiver neles, diga claramente que não "
                "encontrou informação confiável. Cite as fontes (URLs) quando útil. "
                "Não invente dados, nomes, vídeos, canais nem URLs que não estejam "
                "nos resultados:"
            )
            messages.insert(-1, {"role": "system", "content": f"{hint}\n\n{context}"})

    return stream_chat(messages, providers, vision=use_vision)


@app.post("/api/search")
def search():
    data = request.get_json(silent=True) or {}
    query = (data.get("query") or "").strip()
    if not query:
        return jsonify({"error": "query vazia"}), 400
    return jsonify({"results": web_search(query)})


@app.post("/api/image")
def api_image():
    data = request.get_json(silent=True) or {}
    prompt = (data.get("prompt") or "").strip()
    if not prompt:
        return jsonify({"error": "prompt vazio"}), 400
    subject = extract_image_subject(prompt)
    refs = ""
    try:
        refs = web_search(subject + " visual description character art")
    except Exception:
        refs = ""
    refined = refine_image_prompt(subject, refs)
    url = pollinations_url(refined)
    data_url = ""
    try:
        raw, ctype = fetch_image_bytes(url, timeout=90)
        data_url = "data:" + ctype + ";base64," + base64.b64encode(raw).decode("ascii")
    except Exception:
        data_url = ""
    return jsonify(
        {
            "url": url,
            "data_url": data_url,
            "prompt": refined,
            "subject": subject,
        }
    )


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)
