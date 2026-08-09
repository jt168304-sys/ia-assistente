import base64
import io
import json
import os

from dotenv import load_dotenv
from flask import Flask, Response, jsonify, render_template, request, stream_with_context
from groq import Groq
from PIL import Image
import pytesseract

load_dotenv()

app = Flask(__name__)

GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GROQ_MODEL = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")
OCR_LANG = os.getenv("OCR_LANG", "por+eng")
MAX_IMAGE_DIM = 1600

client = Groq(api_key=GROQ_API_KEY)

SYSTEM_PROMPT = (
    "Você é um assistente pessoal inteligente, amigável e preciso. "
    "Responda SEMPRE em português do Brasil, de forma clara e objetiva. "
    "Quando o usuário enviar uma imagem junto com a mensagem, o texto extraído "
    "da imagem via OCR será fornecido no contexto — use-o para responder "
    "perguntas sobre o conteúdo da imagem. Formate respostas com Markdown "
    "quando fizer sentido (listas, trechos de código, negrito)."
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


@app.get("/api/health")
def health():
    return jsonify({"status": "ok", "model": GROQ_MODEL})


@app.post("/api/chat")
def chat():
    data = request.get_json(silent=True) or {}
    message = (data.get("message") or "").strip()
    history = data.get("history") or []
    image = data.get("image") or None

    if not message and not image:
        return jsonify({"error": "mensagem vazia"}), 400

    if not GROQ_API_KEY:
        return jsonify({"error": "GROQ_API_KEY nao configurada"}), 500

    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    messages.extend(history)

    user_content = message
    if image:
        try:
            ocr_text = ocr_from_data_url(image).strip()
        except Exception:
            ocr_text = ""
        parts = []
        if message:
            parts.append(message)
        else:
            parts.append("Analise o conteúdo desta imagem e descreva o que você enxerga.")
        if ocr_text:
            parts.append(f"Texto extraído da imagem (OCR):\n{ocr_text}")
        user_content = "\n\n".join(parts)

    messages.append({"role": "user", "content": user_content})

    def generate():
        try:
            stream = client.chat.completions.create(
                model=GROQ_MODEL,
                messages=messages,
                stream=True,
                temperature=0.7,
                max_tokens=2048,
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


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)
