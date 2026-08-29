import base64
import io
import json
import os
import random
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

GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GROQ_MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")
VISION_MODEL = os.getenv("GROQ_VISION_MODEL", "qwen/qwen3.6-27b").strip()
IMAGE_API_URL = os.getenv("IMAGE_API_URL", "https://image.pollinations.ai/prompt/").strip()
OCR_LANG = os.getenv("OCR_LANG", "por+eng")
MAX_IMAGE_DIM = 1600

client = Groq(api_key=GROQ_API_KEY) if GROQ_API_KEY else None


def reasoning_param(model):
    """Cada modelo da conta aceita valores diferentes de reasoning_effort.
    qwen aceita 'none' (desliga o raciocínio); gpt-oss aceita low/medium/high."""
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
    "um HTML ou qualquer documento, gere o conteúdo completo dentro de um bloco de código "
    "delimitado por ``` com a linguagem indicada (ex.: ```python, ```csv, ```json, ```html). "
    "Assim o app permite baixar o arquivo. Seja criativo e proativo: ofereça exemplos, "
    "códigos, planos e formatos úteis. Sempre que fizer sentido, entregue o conteúdo "
    "pronto para uso e download. "
    "NUNCA invente informações. Se você não souber ou não tiver certeza, diga claramente "
    "que não sabe ou que não encontrou a informação — jamais invente fatos, URLs, números, "
    "nomes de vídeos, canais, obras, autores ou dados para parecer útil. Responda apenas "
    "com base no que você realmente sabe ou nos resultados de pesquisa fornecidos no "
    "contexto."
)


def build_system_prompt():
    """Prompt de sistema + data e hora atuais para o YuIA responder sobre tempo."""
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


@app.get("/")
def index():
    return render_template("index.html")


# Rotas que espelham a estrutura de assets usada no APK Android
# (caminhos relativos em index.html funcionam tanto no Flask quanto no file:///android_asset)
@app.get("/css/<path:filename>")
def css(filename):
    return send_from_directory("static/css", filename)


@app.get("/js/<path:filename>")
def js(filename):
    return send_from_directory("static/js", filename)


@app.get("/api/health")
def health():
    return jsonify(
        {
            "status": "ok",
            "model": GROQ_MODEL,
            "vision_model": VISION_MODEL if VISION_MODEL and VISION_MODEL.lower() != "none" else None,
            "image_api": "pollinations" if IMAGE_API_URL else None,
        }
    )


def build_messages(system_prompt, history, text, ocr_text, image_data_url):
    messages = [{"role": "system", "content": system_prompt}]
    messages.extend(history)

    use_vision = bool(
        image_data_url
        and VISION_MODEL
        and VISION_MODEL.lower() != "none"
        and client is not None
    )

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


def stream_chat(messages, model, max_tokens=1500):
    def generate():
        try:
            stream = client.chat.completions.create(
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
                    payload = json.dumps({"type": "delta", "content": delta}, ensure_ascii=False)
                    yield f"data: {payload}\n\n"
            yield f"data: {json.dumps({'type': 'done'})}\n\n"
        except Exception as exc:
            payload = json.dumps({"type": "error", "content": str(exc)}, ensure_ascii=False)
            yield f"data: {payload}\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


def web_search(query, max_results=5):
    """Busca na web usando DuckDuckGo (pacote 'ddgs'). Retorna string formatada ou ''."""
    try:
        from ddgs import DDGS
    except Exception:
        return ""

    try:
        with DDGS() as ddgs:
            results = list(ddgs.text(query, max_results=max_results))
    except Exception:
        return ""

    if not results:
        return ""

    lines = []
    for i, r in enumerate(results, 1):
        title = (r.get("title") or "").strip()
        href = (r.get("href") or "").strip()
        body = (r.get("body") or "").strip()
        if len(body) > 180:
            body = body[:180].rsplit(" ", 1)[0] + "..."
        lines.append(f"{i}. {title}\n   URL: {href}\n   {body}")
    return "\n\n".join(lines)


@app.post("/api/chat")
def chat():
    data = request.get_json(silent=True) or {}
    message = (data.get("message") or "").strip()
    history = data.get("history") or []
    image = data.get("image") or None
    search = data.get("search", True)

    if not message and not image:
        return jsonify({"error": "mensagem vazia"}), 400

    if not client:
        return jsonify({"error": "GROQ_API_KEY nao configurada"}), 500

    ocr_text = ""
    if image:
        try:
            ocr_text = ocr_from_data_url(image).strip()
        except Exception:
            ocr_text = ""

    messages, _ = build_messages(build_system_prompt(), history, message, ocr_text, image)

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

    model = VISION_MODEL if (image and VISION_MODEL and VISION_MODEL.lower() != "none") else GROQ_MODEL
    return stream_chat(messages, model)


@app.post("/api/search")
def search():
    data = request.get_json(silent=True) or {}
    query = (data.get("query") or "").strip()
    if not query:
        return jsonify({"error": "query vazia"}), 400
    return jsonify({"results": web_search(query)})


def enhance_image_prompt(prompt):
    """Traduz e detalha o prompt para inglês usando a Groq, melhorando a qualidade da imagem.
    Usa a busca na web como referência para descrever corretamente o assunto pedido."""
    if not client:
        return prompt

    reference = web_search(prompt)
    user_content = prompt
    if reference:
        user_content += (
            "\n\nResultados de pesquisa na web sobre o assunto. Use-os APENAS se ajudarem "
            "a descrever o que o usuário pediu (ex.: aparência real de um personagem, "
            "objeto ou lugar). Ignore resultados irrelevantes:\n"
            + reference
        )

    system = (
        "You are an expert image prompt engineer. Convert the user's request into a "
        "detailed English prompt for an AI image generator. "
        "CRITICAL RULE: you must reproduce the user's scene EXACTLY. If the user says "
        "'one banana on a wooden table', the prompt MUST contain a realistic single banana "
        "resting on a real wooden table, with no other objects added and no fantastical "
        "reinterpretation. Never change the subject, never add creatures, never invent "
        "species, never replace the background object the user named. If web reference "
        "describes a real person/character/object, use those REAL details (hair, clothes, "
        "colors, props) so the image looks like the actual thing. Keep every element the "
        "user mentioned and only add generic style/quality words (photorealistic, natural "
        "lighting, sharp focus, high detail, professional photography). "
        "Reply ONLY with the English prompt, without quotes or extra text."
    )
    try:
        resp = client.chat.completions.create(
            model=GROQ_MODEL,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user_content},
            ],
            max_tokens=400,
            temperature=0.7,
            **reasoning_param(GROQ_MODEL),
        )
        text = (resp.choices[0].message.content or "").strip()
        if text:
            return text
    except Exception:
        pass
    return prompt


def download_image(url, timeout=90):
    """Baixa a imagem gerada para inspeção."""
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def verify_generated_image(prompt, image_bytes):
    """Usa o modelo de visão para conferir se a imagem gerada corresponde ao pedido.
    Faz até 2 votos e aceita se qualquer um disser SIM (o modelo de visão é um pouco
    instável em perguntas binárias). Em erro, aceita (True) para não bloquear o fluxo."""

    def vote():
        b64 = base64.b64encode(image_bytes).decode()
        data_url = f"data:image/jpeg;base64,{b64}"
        messages = [
            {"role": "system", "content": "Você é um verificador de imagens. Responda somente SIM ou NÃO."},
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": f"Diga SIM se a imagem mostra: {prompt}. NÃO caso contrário. Responda somente SIM ou NÃO.",
                    },
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            },
        ]
        resp = client.chat.completions.create(
            model=VISION_MODEL,
            messages=messages,
            max_tokens=15,
            temperature=0,
            **reasoning_param(VISION_MODEL),
        )
        ans = (resp.choices[0].message.content or "").strip().lower()
        return ans.startswith("sim") or " sim" in ans or ans == "sim."

    if not client or not VISION_MODEL or VISION_MODEL.lower() == "none":
        return True
    try:
        return vote() or vote()
    except Exception:
        return True


@app.post("/api/image")
def image():
    data = request.get_json(silent=True) or {}
    prompt = (data.get("prompt") or "").strip()
    width = int(data.get("width") or 896)
    height = int(data.get("height") or 1024)

    if not prompt:
        return jsonify({"error": "prompt vazio"}), 400

    if not IMAGE_API_URL:
        return jsonify({"error": "geração de imagem não configurada"}), 500

    width = max(256, min(1536, width))
    height = max(256, min(1536, height))

    enhanced = enhance_image_prompt(prompt)
    candidate = None
    for _ in range(3):
        seed = random.randint(1, 999999)
        candidate = (
            f"{IMAGE_API_URL.rstrip('/')}/"
            f"{urllib.parse.quote(enhanced)}"
            f"?width={width}&height={height}&seed={seed}&nologo=true&model=flux&enhance=true"
        )
        try:
            data_bytes = download_image(candidate)
        except Exception:
            continue
        if verify_generated_image(prompt, data_bytes):
            break

    if not candidate:
        return jsonify({"error": "falha ao gerar a imagem"}), 502
    return jsonify({"url": candidate, "prompt": prompt})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)
