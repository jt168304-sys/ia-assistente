# IA Assistente

Assistente de IA com interface no estilo **ChatGPT**, tema **preto e azul**, construído em **Python (Flask) + Groq**, que roda no computador e também vira um **APK Android** — o mesmo código de interface serve para as duas plataformas.

## Funcionalidades

- Campo de digitação de texto (envio por Enter ou botão).
- **Leitor de imagem** via OCR: no computador usa Tesseract; no APK usa o ML Kit (Google), embutido no app.
- **Assistente de voz**:
  - Ditado por microfone (Web Speech API no navegador; `RecognizerIntent` no APK).
  - **Narração das respostas com a voz nativa do aparelho** (TTS), mostrando o texto enquanto narra.
- Respostas em **streaming** (aparecem token por token, sincronizadas com a narração).
- Seletor de voz, velocidade da narração e botão "Narrar" para reler qualquer resposta.
- Atalhos de sugestão e botão "Novo chat".

## Como funciona

```mermaid
graph TD
    A["Interface (HTML/CSS/JS)"] --> B{"Onde está rodando?"}
    B -->|"Computador (Flask)"| C["app.py (Python)"]
    C --> D["API Groq (streaming)"]
    C --> E["OCR via Tesseract"]
    B -->|"APK (Android)"| F["WebView + ponte nativa"]
    F --> G["Chamada direta à API Groq"]
    F --> H["TTS nativo do Android"]
    F --> I["Reconhecimento de voz (RecognizerIntent)"]
    F --> J["OCR via ML Kit"]
```

- **No computador**: o servidor Flask (`app.py`) mantém a chave da API no servidor e faz o OCR com Tesseract.
- **No APK**: o WebView carrega os mesmos arquivos de interface (`templates/` e `static/`), e uma ponte Java (`MainActivity`) oferece TTS, microfone e OCR nativos. A chave da API é injetada no APK **em tempo de build** via secret do GitHub — nunca fica no código-fonte.

## Estrutura

```
.
├── app.py                     # Backend Flask (modo computador)
├── requirements.txt           # Dependências Python
├── .env.example               # Modelo do arquivo .env
├── templates/index.html       # Interface (compartilhada)
├── static/css/style.css       # Tema preto e azul (compartilhado)
├── static/js/app.js           # Lógica do frontend (compartilhada)
├── android/                   # Projeto Android (WebView + ponte nativa)
│   ├── app/src/main/java/.../MainActivity.java
│   └── build.gradle           # Copia o frontend compartilhado e injeta a chave
└── .github/workflows/build-apk.yml  # Gera o APK na aba Actions
```

## Como rodar no computador

Requisitos: Python 3.10+, uma chave da [Groq](https://console.groq.com/keys) e o Tesseract.

```bash
# 1. Crie o arquivo .env com sua chave
cp .env.example .env
# edite o .env e cole sua GROQ_API_KEY

# 2. Instale as dependências
pip install --break-system-packages -r requirements.txt

# 3. Instale o Tesseract (para o leitor de imagem)
#   Windows: https://github.com/UB-Mannheim/tesseract/wiki (adicione ao PATH)
#   Linux:   sudo apt install tesseract-ocr tesseract-ocr-por
#   macOS:   brew install tesseract tesseract-lang

# 4. Rode
python3 app.py
```

Acesse `http://localhost:5000`. Use o **Chrome** (Android ou desktop) para voz e narração.

## Como gerar o APK

### Pela aba Actions (recomendado)

1. No repositório, vá em **Settings → Secrets and variables → Actions** e adicione o secret `GROQ_API_KEY` com sua chave da Groq.
2. Abra a aba **Actions** → *Build APK* → **Run workflow** (ou faça um push; o build roda automaticamente).
3. Ao terminar, baixe o artefato `ia-assistente-apk` e instale o `app-debug.apk` no celular Android.

> O APK embute a chave da API em tempo de build. Por isso, use o repositório como **privado** ou troque a chave se o projeto for tornar-se público.

### Localmente (Android Studio ou linha de comando)

```bash
cd android
GROQ_API_KEY=suachave ./gradlew assembleDebug
# APK em: android/app/build/outputs/apk/debug/app-debug.apk
```

## Variáveis de ambiente

| Variável | Descrição | Padrão |
|---|---|---|
| `GROQ_API_KEY` | Chave de API da Groq (obrigatória) | — |
| `GROQ_MODEL` | Modelo usado nas respostas | `llama-3.3-70b-versatile` |
| `OCR_LANG` | Idiomas do Tesseract (modo computador) | `por+eng` |
| `PORT` | Porta do servidor Flask | `5000` |

## Observações

- A narração e o ditado usam os recursos nativos do aparelho (Web Speech API no navegador; TTS e `RecognizerIntent` no Android).
- O arquivo `.env` contém sua chave secreta e **não deve ser commitado** (já está no `.gitignore`).
- A interface é a mesma nos dois ambientes: `static/js/app.js` detecta se está rodando no WebView do APK (`window.AndroidBridge`) ou no navegador.
