# IA Assistente (interface estilo ChatGPT em Python)

Aplicativo web em Python (Flask + Groq) com interface preta e azul estilo ChatGPT:

- Campo de digitação de texto
- Leitor de imagem (OCR local via Tesseract, português + inglês)
- Assistente de voz: ditado por microfone e narração das respostas com a voz nativa do aparelho (Web Speech API)
- Respostas em streaming exibidas enquanto a IA narra

## Requisitos

- Python 3.10+
- Uma chave de API da [Groq](https://console.groq.com/keys)
- Tesseract OCR (para o leitor de imagem)

### Instalando o Tesseract

- Windows: https://github.com/UB-Mannheim/tesseract/wiki (adicione ao PATH)
- Linux: `sudo apt install tesseract-ocr tesseract-ocr-por`
- macOS: `brew install tesseract tesseract-lang`

## Configuração

Crie o arquivo `.env` na raiz do projeto:

```
GROQ_API_KEY=SUA_CHAVE_DA_GROQ
GROQ_MODEL=llama-3.3-70b-versatile
OCR_LANG=por+eng
```

## Como rodar

```bash
pip install --break-system-packages -r requirements.txt
python3 app.py
```

Abra `http://localhost:5000` no Chrome (Android ou desktop) para usar voz e microfone.

## Avisos

- O arquivo `.env` contém sua chave secreta e **não deve ser commitado**.
- A narração e o ditado usam as capacidades nativas do navegador/aparelho (Web Speech API).
