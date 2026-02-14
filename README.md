# 🎙️ AI Voice Agent

A real-time AI voice conversation agent built with **Python**. It enables natural, human-like voice interactions using **Deepgram** for speech-to-text & text-to-speech, **Grok (X.AI)** LLM for intelligent responses, and a **WebSocket** pipeline for low-latency bidirectional audio streaming — with sentence-level streaming, barge-in support, automatic error recovery, and latency tracking.

**Author:** Pratham Makhija

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                          WebSocket Client                          │
│                  (any app sending/receiving audio)                  │
└──────────────┬──────────────────────────────────┬───────────────────┘
               │  binary: mic audio (16kHz PCM)   │  binary: TTS audio (24kHz PCM)
               │  json: control messages           │  json: transcripts, status
               ▼                                   ▲
┌──────────────────────────────────────────────────────────────────────┐
│                     WebSocket Server (ws_handler.py)                │
│              • Session management (per-client UUID)                 │
│              • Binary/JSON protocol routing                        │
│              • Chunked audio streaming + heartbeat                 │
└──────┬───────────────────────────────────────────────────┬──────────┘
       │                                                   ▲
       ▼                                                   │
┌──────────────┐    ┌──────────────┐    ┌─────────────────────────────┐
│  Deepgram    │    │   LLM        │    │  Deepgram TTS               │
│  STT         │    │   Provider   │    │  (tts.py)                   │
│  (stt.py)    │    │ (provider.py)│    │                             │
│              │    │              │    │  • Aura Asteria voice       │
│  • Nova-2    │    │  • Grok-3    │    │  • Sentence-level synthesis │
│  • Streaming │───▶│    (X.AI)    │───▶│  • Retry w/ backoff        │
│  • VAD       │    │  • OpenAI-   │    │  • 24kHz linear16 output   │
│  • Interim + │    │    compat SDK│    └─────────────────────────────┘
│    final     │    │              │
│  • Keepalive │    │  • Streaming │    ┌─────────────────────────────┐
│  • Reconnect │    │  • Retry     │    │  Conversation Memory        │
└──────────────┘    │  • Persona ◀─────│  (conversation_memory.py)   │
                    │    injection │    │                             │
                    └──────────────┘    │  • Per-session history      │
                                        │  • Sliding window (max 20) │
                                        │  • Optional summarization  │
                                        └─────────────────────────────┘
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
| 🧠 **LLM Integration**     | Grok-3 (X.AI) via OpenAI-compatible SDK for conversation handling              |
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
voice-agent/
├── main.py                                 # Entry point — orchestrates all services
├── requirements.txt                        # Python dependencies
├── README.md
└── app/
    ├── __init__.py
    ├── config/
    │   ├── __init__.py
    │   └── config.py                       # Central configuration (API keys, models, settings)
    ├── ws/
    │   ├── __init__.py
    │   └── ws_handler.py                   # WebSocket server (binary audio + JSON control)
    └── services/
        ├── __init__.py
        ├── deepgram/
        │   ├── __init__.py
        │   ├── stt.py                      # Deepgram streaming Speech-to-Text
        │   └── tts.py                      # Deepgram Text-to-Speech (with retry)
        ├── llm/
        │   ├── __init__.py
        │   ├── provider.py                 # Grok LLM provider (OpenAI-compatible SDK)
        │   └── persona.py                  # AI persona definition & system prompt
        └── memory/
            ├── __init__.py
            └── conversation_memory.py      # Per-session conversation history management
```

---

## Installation

### Prerequisites

- **Python 3.10+**
- **Deepgram API Key** — [console.deepgram.com](https://console.deepgram.com)
- **Grok API Key** — [console.x.ai](https://console.x.ai)

### Steps

```bash
# 1. Navigate to project
cd voice-agent

# 2. Create a virtual environment (recommended)
python -m venv venv
source venv/bin/activate        # Linux/macOS
# or
venv\Scripts\activate           # Windows

# 3. Install dependencies
pip install -r requirements.txt

# 4. Create .env file
cp .env.example .env
# Edit .env and add your API keys
```

---

## Configuration

Create a `.env` file in the project root:

```env
DEEPGRAM_API_KEY=your_deepgram_api_key_here
GROK_API_KEY=your_grok_api_key_here

# Optional overrides
# LLM_MODEL=grok-3
# LLM_TEMPERATURE=0.7
# LLM_MAX_TOKENS=300
WS_PORT=8080
```

All settings (STT model, TTS voice, LLM model, memory strategy, etc.) can be adjusted in `app/config/config.py`.

---

## Usage

```bash
# Start the voice agent server
python main.py
```

The server starts a WebSocket endpoint at `ws://localhost:8080`. Connect any WebSocket client that sends raw audio (linear16, 16 kHz, mono) as binary frames and handles the JSON + binary response protocol described below.

---

## WebSocket Protocol

### Client → Server

| Data Type | Description                                               |
| --------- | --------------------------------------------------------- |
| Binary    | Raw audio chunks (linear16, 16 kHz, mono)                 |
| JSON      | Control messages: `{type: 'end' / 'clear' / 'interrupt'}` |

### Server → Client

| Message Type        | Description                      |
| ------------------- | -------------------------------- |
| `connected`         | Session established              |
| `transcript`        | STT result (interim or final)    |
| `thinking`          | LLM is generating a response     |
| `speaking`          | TTS audio streaming started      |
| `audio_start`       | Audio stream beginning           |
| Binary data         | TTS audio chunks                 |
| `audio_end`         | Audio stream complete            |
| `audio_interrupted` | Barge-in: response was cancelled |
| `response`          | Full AI response text            |
| `error`             | Error message                    |

---

## Tech Stack

| Component      | Technology                         |
| -------------- | ---------------------------------- |
| **Runtime**    | Python 3.10+ / asyncio             |
| **WebSocket**  | websockets                         |
| **STT**        | Deepgram Nova-2 (streaming)        |
| **TTS**        | Deepgram Aura (Asteria voice)      |
| **LLM**        | Grok-3 (X.AI)                      |
| **LLM Client** | openai SDK (OpenAI-compatible API) |
| **Config**     | python-dotenv                      |
