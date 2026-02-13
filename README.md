# 🎙️ AI Voice Agent (Python)

A production-grade, real-time AI voice conversation agent built with **Python**. It enables natural, human-like voice interactions using **Deepgram** for speech-to-text & text-to-speech, **Grok LLM** for intelligent responses, and a **WebSocket** pipeline for ultra-low-latency bidirectional audio streaming — complete with sentence-level streaming, barge-in interruption support, automatic error recovery, and comprehensive latency tracking.

**Author:** Pratham Makhija

---

## Features

| Feature                    | Description                                                                    |
| -------------------------- | ------------------------------------------------------------------------------ |
| 🗣️ **Real-time STT**       | Deepgram Nova-2 streaming transcription with interim results & VAD             |
| 🧠 **LLM Integration**     | Grok (X.AI), OpenAI, or Anthropic — configurable via env vars                  |
| 👤 **AI Persona**          | "Nova" — a friendly, voice-optimized assistant with consistent personality     |
| 💾 **Conversation Memory** | Sliding window + optional LLM-powered summarization for context compaction     |
| 🔊 **Sentence-Level TTS**  | Deepgram Aura TTS with sentence-by-sentence streaming for faster time-to-voice |
| ⚡ **Barge-In Support**    | Users can interrupt the AI mid-response with voice — server-side cancellation  |
| 🔄 **Retry Logic**         | Exponential backoff with jitter on all external API calls (LLM & TTS)          |
| 📡 **Auto-Reconnect**      | Client automatically reconnects on disconnect with exponential backoff         |
| 📊 **Latency Metrics**     | End-to-end pipeline latency tracking: STT → LLM → TTS per request              |
| 🌐 **WebSocket Streaming** | Binary audio + JSON control protocol with chunked delivery & heartbeat         |
| 🛡️ **Error Handling**      | Graceful degradation, STT reconnection, fallback TTS responses                 |

---

## Project Structure

```
voice-agent/
├── main.py                                 # Main orchestrator — connects all services
├── requirements.txt                        # Python dependencies
├── README.md                               # This file
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
        │   ├── provider.py                 # LLM provider (Grok via OpenAI-compatible API)
        │   └── persona.py                  # AI persona definition & system prompt
        └── memory/
            ├── __init__.py
            └── conversation_memory.py      # Per-session conversation history management
```

---

## High-Level Architecture

```
  Client Audio → WebSocket → Deepgram STT → Text
                                              ↓
  Client ← WebSocket ← Deepgram TTS ← Grok LLM (+ Persona + Memory)
```

---

## Installation

### Prerequisites

- **Python 3.10+**
- **Deepgram API Key** — Get it from [console.deepgram.com](https://console.deepgram.com)
- **Grok API Key** — Get it from [console.x.ai](https://console.x.ai)

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

Create a `.env` file in the `voice-agent/` directory:

```env
DEEPGRAM_API_KEY=your_deepgram_api_key_here

# LLM provider: grok | openai | anthropic
LLM_PROVIDER=grok
GROK_API_KEY=your_grok_api_key_here
# OPENAI_API_KEY=your_openai_api_key_here
# ANTHROPIC_API_KEY=your_anthropic_api_key_here

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

Then open `client.html` in a browser and click **Connect** → press the **🎤 mic button** to talk.

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

| Component      | Technology                              |
| -------------- | --------------------------------------- |
| **Runtime**    | Python 3.10+ / asyncio                  |
| **WebSocket**  | websockets                              |
| **STT**        | Deepgram Nova-2 (streaming)             |
| **TTS**        | Deepgram Aura (Asteria voice)           |
| **LLM**        | Grok-3 / GPT-4o / Claude (configurable) |
| **LLM Client** | openai + anthropic (Python SDKs)        |
| **Config**     | python-dotenv                           |
