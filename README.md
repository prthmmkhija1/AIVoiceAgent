# 🎙️ AI Voice Agent

A real-time AI voice conversation agent built with **Python**. It enables natural, human-like voice interactions using **Deepgram** for speech-to-text & text-to-speech, **Groq LLM** for intelligent responses, and a **WebSocket** pipeline for low-latency bidirectional audio streaming — with sentence-level streaming, barge-in support, automatic error recovery, and latency tracking. Includes a ready-to-use browser client (`client.html`).

**Author:** Pratham Makhija

---

## Architecture

```
┌───────────────────────────────────────────────────────────────────────────┐
│                     client.html  (Browser UI)                            │
│          Mic capture (16kHz linear16) ←→ TTS playback (24kHz)            │
└───────────────────┬───────────────────────────────┬───────────────────────┘
                    │                               │
                    │  binary: mic audio (16kHz)     │  binary: TTS audio (24kHz)
                    │  json:   control messages      │  json:   transcripts, status
                    ▼                               ▲
┌───────────────────────────────────────────────────────────────────────────┐
│                      WebSocket Server (ws_handler.py)                    │
│                                                                          │
│          • Session management (per-client UUID)                          │
│          • Binary / JSON protocol routing                                │
│          • Chunked audio streaming + heartbeat                           │
└───────────────────┬───────────────────────────────┬───────────────────────┘
                    │                               ▲
                    ▼                               │
┌───────────────────────┐  ┌───────────────────────┐  ┌───────────────────────┐
│    Deepgram STT       │  │    LLM Provider       │  │    Deepgram TTS       │
│    (stt.py)           │  │    (provider.py)       │  │    (tts.py)           │
│                       │  │                       │  │                       │
│  • Nova-2 model       │  │  • Groq (default)    │  │  • Aura Asteria voice │
│  • Streaming          │─▶│  • OpenAI-compat SDK  │─▶│  • Sentence-level     │
│  • VAD events         │  │  • Token streaming    │  │    synthesis           │
│  • Interim + final    │  │  • Retry w/ backoff   │  │  • Retry w/ backoff   │
│  • Keepalive          │  │  • Persona injection  │  │  • 24kHz linear16     │
│  • Auto-reconnect     │  │                       │  │                       │
└───────────────────────┘  └───────────┬───────────┘  └───────────────────────┘
                                       │
                                       ▼
                           ┌───────────────────────────┐
                           │   Conversation Memory      │
                           │  (conversation_memory.py)  │
                           │                            │
                           │  • Per-session history     │
                           │  • Sliding window (max 20) │
                           │  • Optional summarization  │
                           └───────────────────────────┘
```

### Data Flow

```
  User speaks → WebSocket → Deepgram STT → Transcript (text)
                                                  ↓
                                           Memory (add user msg)
                                                  ↓
                                        LLM stream (+ Persona + History)
                                                  ↓
                                       Sentence detection (regex)
                                                  ↓
                                         Deepgram TTS (per sentence)
                                                  ↓
                                     WebSocket ← Audio chunks → User hears
```

---

## Features

| Feature                    | Description                                                                    |
| -------------------------- | ------------------------------------------------------------------------------ |
| 🗣️ **Real-time STT**       | Deepgram Nova-2 streaming transcription with interim results & VAD             |
| 🧠 **LLM Integration**     | Groq (default) / Grok / OpenAI / Anthropic — switchable via env variable       |
| 👤 **AI Persona**          | "Nova" — a friendly, voice-optimized assistant with consistent personality     |
| 💾 **Conversation Memory** | Sliding window + optional LLM-powered summarization for context compaction     |
| 🔊 **Sentence-Level TTS**  | Deepgram Aura TTS with sentence-by-sentence streaming for faster time-to-voice |
| ⚡ **Barge-In Support**    | Users can interrupt the AI mid-response — server-side cancellation             |
| 🔄 **Retry & Reconnect**   | Exponential backoff with jitter on all external API calls + STT auto-reconnect |
| 📊 **Latency Metrics**     | End-to-end pipeline latency tracking: STT → LLM → TTS per request              |
| 🌐 **WebSocket Streaming** | Binary audio + JSON control protocol with chunked delivery & heartbeat         |
| 🛡️ **Error Handling**      | Graceful degradation, fallback TTS responses, clean session teardown           |

---

## Project Structure

```
AIVoiceAgent/
│
├── main.py                          # Entry point — orchestrates all services
├── client.html                      # Browser-based voice client (open in browser)
├── requirements.txt                 # Python dependencies
├── .env                             # Your API keys (gitignored)
├── README.md
│
└── app/
    ├── __init__.py
    │
    ├── config/
    │   ├── __init__.py
    │   └── config.py                # Central configuration (API keys, models, settings)
    │
    ├── ws/
    │   ├── __init__.py
    │   └── ws_handler.py            # WebSocket server (binary audio + JSON control)
    │
    └── services/
        ├── __init__.py
        │
        ├── deepgram/
        │   ├── __init__.py
        │   ├── stt.py               # Deepgram streaming Speech-to-Text
        │   └── tts.py               # Deepgram Text-to-Speech (with retry)
        │
        ├── llm/
        │   ├── __init__.py
        │   ├── provider.py          # Multi-provider LLM (OpenAI-compatible + Anthropic)
        │   └── persona.py           # AI persona definition & system prompt
        │
        └── memory/
            ├── __init__.py
            └── conversation_memory.py   # Per-session conversation history management
```

---

## Quick Start (Step-by-Step)

### Prerequisites

| Requirement      | Details                                                            |
| ---------------- | ------------------------------------------------------------------ |
| **Python**       | 3.10 or newer                                                      |
| **Deepgram key** | [console.deepgram.com](https://console.deepgram.com)               |
| **Groq key**     | [console.groq.com](https://console.groq.com) (free tier available) |
| **Browser**      | Chrome, Edge, or Firefox (for `client.html`)                       |
| **Microphone**   | Any mic — the browser will ask for permission                      |

### Step 1 — Navigate to the project

```bash
cd AIVoiceAgent
```

### Step 2 — Create & activate a virtual environment

```bash
# Create
python -m venv venv

# Activate (Windows PowerShell)
venv\Scripts\Activate.ps1

# Activate (Windows CMD)
venv\Scripts\activate.bat

# Activate (Linux / macOS)
source venv/bin/activate
```

### Step 3 — Install dependencies

```bash
pip install -r requirements.txt
```

### Step 4 — Configure environment variables

Edit the `.env` file in the project root and add your API keys:

```env
# Required
DEEPGRAM_API_KEY=your_deepgram_api_key
GROQ_API_KEY=your_groq_api_key

# Provider selection (default: groq)
LLM_PROVIDER=groq

WS_PORT=8080
```

> **Supported providers & their env vars:**
>
> | Provider    | Env Key             | Default Model              |
> | ----------- | ------------------- | -------------------------- |
> | `groq`      | `GROQ_API_KEY`      | `llama-3.3-70b-versatile`  |
> | `grok`      | `GROK_API_KEY`      | `grok-3`                   |
> | `openai`    | `OPENAI_API_KEY`    | `gpt-4o`                   |
> | `anthropic` | `ANTHROPIC_API_KEY` | `claude-sonnet-4-20250514` |
>
> Anthropic requires an extra install: `pip install anthropic>=0.20.0`

### Step 5 — Start the server

```bash
python main.py
```

You should see:

```
╔══════════════════════════════════════╗
║     🎙️  AI Voice Agent Starting      ║
╚══════════════════════════════════════╝

✅ Configuration validated (LLM provider: groq)
✅ All services initialized
📋 Configuration:
   LLM: GROQ (llama-3.3-70b-versatile)
   STT: Deepgram (nova-2)
   TTS: Deepgram (aura-asteria-en)
   WebSocket: ws://localhost:8080
🎧 Waiting for client connections...
```

### Step 6 — Open the browser client

Open `client.html` in your browser (just double-click the file, or):

```bash
start client.html              # Windows
open client.html               # macOS
xdg-open client.html           # Linux
```

1. Click **🎤 Start** — connects to the WebSocket server and starts your microphone.
2. **Speak** — live transcription appears, then Nova's voice response plays back.
3. Click **⏹️ Interrupt** to barge-in mid-response.
4. Click **🗑️ Clear** to reset conversation memory.
5. Click **⏹ Stop** to end the session.

---

## Configuration

All settings are in `app/config/config.py` and can be overridden via `.env`:

| Setting          | Env Variable       | Default      | Description                              |
| ---------------- | ------------------ | ------------ | ---------------------------------------- |
| Deepgram API Key | `DEEPGRAM_API_KEY` | —            | Required                                 |
| Groq API Key     | `GROQ_API_KEY`     | —            | Required (for default Groq provider)     |
| LLM Provider     | `LLM_PROVIDER`     | `groq`       | `groq` / `grok` / `openai` / `anthropic` |
| LLM Model        | `LLM_MODEL`        | per-provider | Override the default model               |
| LLM Temperature  | `LLM_TEMPERATURE`  | `0.7`        | Response creativity                      |
| LLM Max Tokens   | `LLM_MAX_TOKENS`   | `300`        | Max response length                      |
| WebSocket Port   | `WS_PORT`          | `8080`       | Server listen port                       |

Memory settings (in `config.py`):

- `max_messages`: Sliding window size (default: 20)
- `use_summarization`: Enable LLM-powered summarization (default: false)
- `summarize_after`: Trigger summarization threshold (default: 15)

---

## WebSocket Protocol

### Client → Server

| Data Type | Description                                                 |
| --------- | ----------------------------------------------------------- |
| Binary    | Raw audio chunks (linear16, 16 kHz, mono)                   |
| JSON      | `{type: "end"}` / `{type: "clear"}` / `{type: "interrupt"}` |

### Server → Client

| Message Type        | Payload                    | Description                       |
| ------------------- | -------------------------- | --------------------------------- |
| `connected`         | `{ sessionId, message }`   | Session established               |
| `transcript`        | `{ text, isFinal }`        | STT result (interim or final)     |
| `thinking`          | `{}`                       | LLM is generating a response      |
| `speaking`          | `{}`                       | First TTS sentence ready          |
| `audio_start`       | `{ sampleRate, encoding }` | Audio stream beginning            |
| _(binary)_          | Raw bytes                  | TTS audio chunks (linear16 24kHz) |
| `audio_end`         | `{}`                       | Audio stream complete             |
| `audio_interrupted` | `{}`                       | Barge-in: response cancelled      |
| `response`          | `{ text }`                 | Full AI response text             |
| `error`             | `{ message }`              | Error message                     |

---

## Tech Stack

| Component      | Technology                                     |
| -------------- | ---------------------------------------------- |
| **Runtime**    | Python 3.10+ / asyncio                         |
| **WebSocket**  | `websockets` library                           |
| **STT**        | Deepgram Nova-2 (streaming)                    |
| **TTS**        | Deepgram Aura (Asteria voice)                  |
| **LLM**        | Groq (default) / Grok / OpenAI / Anthropic     |
| **LLM Client** | `openai` SDK (OpenAI-compatible API)           |
| **Config**     | `python-dotenv`                                |
| **Frontend**   | Vanilla HTML/JS (Web Audio API, WebSocket API) |

---

## Troubleshooting

| Issue                        | Fix                                                                                |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| `Missing required API keys`  | Check your `.env` file has the correct keys for your chosen provider               |
| Mic not working in browser   | Ensure you're on `localhost` or HTTPS — browsers block mic on insecure origins     |
| No audio playback            | Click somewhere on the page first (browsers require user interaction before audio) |
| WebSocket connection refused | Ensure `python main.py` is running and the port matches `client.html` settings     |
| Anthropic provider           | Not bundled by default — run `pip install anthropic>=0.20.0` if needed             |
