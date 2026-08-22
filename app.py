import base64
import io
import json
import os
import random
import urllib.parse
import urllib.request

from dotenv import load_dotenv
from flask import Flask, Response, jsonify, render_template, request, send_from_directory, stream_with_context
from groq import Groq
from PIL import Image
import pytesseract

load_dotenv()

app = Flask(__name__)

GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GROQ_MODEL = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")
VISION_MODEL = os.getenv("GROQ_VISION_MODEL", "llama-3.2-11b-vision-preview").strip()
IMAGE_API_URL = os.getenv("IMAGE_API_URL", "https://image.pollinations.ai/prompt/").strip()
OCR_LANG = os.getenv("OCR_LANG", "por+eng")
MAX_IMAGE_DIM = 1600

client = Groq(api_key=GROQ_API_KEY) if GROQ_API_KEY else None

SYSTEM_PROMPT = (
    "Você é um assistente pessoal inteligente, amigável e preciso, chamado IA Assistente. "
    "Responda SEMPRE em português do Brasil, de forma clara, objetiva e completa. "
    "Você pode receber imagens: analise-as diretamente (visão) e use o texto de OCR "
    "fornecido como contexto auxiliar quando presente. "
    "Formate respostas com Markdown quando fizer sentido (listas, tabelas, trechos de código). "
    "Quando o usuário pedir para criar um arquivo, um script, uma planilha CSV, um JSON, "
    "um HTML ou qualquer documento, gere o conteúdo completo dentro de um bloco de código "
    "delimitado por ``` com a linguagem indicada (ex.: ```python, ```csv, ```json, ```html). "
    "Assim o app permite baixar o arquivo. Seja criativo e proativo: ofereça exemplos, "
    "códigos, planos e formatos úteis. Sempre que fizer sentido, entregue o conteúdo "
    "pronto para uso e download."
)


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


def stream_chat(messages, model, max_tokens=4096):
    def generate():
        try:
            stream = client.chat.completions.create(
                model=model,
                messages=messages,
                stream=True,
                temperature=0.7,
                max_tokens=max_tokens,
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


@app.post("/api/chat")
def chat():
    data = request.get_json(silent=True) or {}
    message = (data.get("message") or "").strip()
    history = data.get("history") or []
    image = data.get("image") or None

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

    messages, _ = build_messages(SYSTEM_PROMPT, history, message, ocr_text, image)

    model = VISION_MODEL if (image and VISION_MODEL and VISION_MODEL.lower() != "none") else GROQ_MODEL
    return stream_chat(messages, model)


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
    seed = random.randint(1, 999999)

    url = (
        f"{IMAGE_API_URL.rstrip('/')}/"
        f"{urllib.parse.quote(prompt)}"
        f"?width={width}&height={height}&seed={seed}&nologo=true&model=flux"
    )
    return jsonify({"url": url, "prompt": prompt})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)
