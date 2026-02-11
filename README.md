# AI Voice Agent

A real-time AI voice assistant that enables natural spoken conversations. Built with **Deepgram** for speech processing (STT & TTS), **Grok (X.AI)** as the LLM backbone, and **WebSocket** streaming for low-latency bidirectional audio communication.

**Author:** Pratham Makhija

---

## Table of Contents

- [Features](#features)
- [Project Structure](#project-structure)
- [Architecture & Data Flow](#architecture--data-flow)
- [Requirements Implementation](#requirements-implementation)
- [Installation](#installation)
- [Configuration](#configuration)
- [Usage](#usage)
- [How It Works](#how-it-works)
- [API & Services Reference](#api--services-reference)
- [Client Interface](#client-interface)
- [Troubleshooting](#troubleshooting)

---

## Features

- **Real-time Speech-to-Text** — Deepgram Nova-2 streaming transcription with interim results
- **LLM Integration** — Grok (X.AI) via OpenAI-compatible API (easily swappable to OpenAI / Anthropic)
- **Consistent AI Persona** — "Nova", a friendly voice-optimized assistant with defined personality traits
- **Conversation Memory** — Sliding window with optional LLM-powered summarization for context compaction
- **Text-to-Speech** — Deepgram Aura TTS converting LLM responses to natural-sounding speech
- **WebSocket Streaming** — Chunked audio delivery with latency optimization
- **Error Handling & Reconnection** — Exponential backoff reconnection, graceful degradation, fallback responses

---

## Project Structure

```
voice-agent/
├── src/
│   ├── config/
│   │   └── config.js                  # Central configuration (API keys, STT/TTS/LLM settings)
│   ├── ws/
│   │   └── wsHandler.js               # WebSocket server (binary audio + JSON control messages)
│   ├── services/
│   │   ├── deepgram/
│   │   │   ├── stt.js                 # Deepgram streaming Speech-to-Text
│   │   │   └── tts.js                 # Deepgram Text-to-Speech
│   │   ├── llm/
│   │   │   ├── provider.js            # LLM provider (Grok/OpenAI/Anthropic abstraction)
│   │   │   └── persona.js             # AI persona definition & system prompt
│   │   └── memory/
│   │       └── conversationMemory.js  # Per-session conversation history management
│   └── app.js                         # Main orchestrator — connects all services
├── client.html                        # Browser-based test client (mic capture + audio playback)
├── .env                               # Environment variables (API keys — not committed)
├── .gitignore                         # Git ignore rules
├── package.json                       # Project metadata & dependencies
└── README.md                          # This file
```

---

## Architecture & Data Flow

```
┌─────────────┐     WebSocket      ┌──────────────────────────────────────────────┐
│   Browser    │◄──────────────────►│              Node.js Server                  │
│  client.html │   Binary Audio +   │                                              │
│              │   JSON Messages    │  ┌─────────┐  ┌─────────┐  ┌─────────────┐  │
│  🎤 Mic ──────► WS Handler ────────► STT      │  │  LLM    │  │   Memory    │  │
│              │                    │  │(Deepgram)├──►(Grok)   ├──►(Sliding Win)│  │
│  🔊 Speaker◄──── WS Handler ◄──────┤ TTS      │◄─┤+Persona │  │+Summarize   │  │
│              │                    │  │(Deepgram)│  │         │  │             │  │
└─────────────┘                     │  └─────────┘  └─────────┘  └─────────────┘  │
                                    └──────────────────────────────────────────────┘
```

**Flow:**

1. User speaks → browser captures mic audio (linear16, 16kHz)
2. Audio streams to server via WebSocket (binary frames)
3. Server forwards audio to **Deepgram STT** for real-time transcription
4. On utterance end (silence detection), the complete transcript is sent to the **Grok LLM**
5. LLM generates a response using the **persona** system prompt and **conversation memory**
6. Response text is converted to speech via **Deepgram TTS**
7. TTS audio is streamed back to the client in chunks for low-latency playback

---

## Requirements Implementation

### 1. Deepgram Streaming STT (Speech-to-Text)

- **File:** `src/services/deepgram/stt.js`
- Uses Deepgram's `listen.live()` WebSocket streaming API
- Nova-2 model with smart formatting, punctuation, and Voice Activity Detection (VAD)
- Interim results for real-time feedback, `UtteranceEnd` event for turn detection
- Connection health: waits for WebSocket `Open` event before sending audio

### 2. LLM Integration (Grok / OpenAI / Anthropic)

- **File:** `src/services/llm/provider.js`
- Currently configured for **Grok (X.AI)** — `grok-3` model via `https://api.x.ai/v1`
- Uses the `openai` npm package (X.AI provides OpenAI-compatible API)
- Supports both **streaming** (`streamResponse()`) and **non-streaming** (`generateResponse()`) modes
- Easily switchable: change `baseURL`, `model`, and API key in `config.js` to use OpenAI or any compatible provider

### 3. Consistent AI Persona

- **File:** `src/services/llm/persona.js`
- Persona name: **Nova** — a friendly, warm AI voice assistant
- Defined personality traits: friendly, patient, knowledgeable, concise, conversational
- Voice-specific guidelines: short responses (2-4 sentences), no markdown/code blocks, natural speech patterns
- System prompt injected into every LLM request via `getSystemPrompt()`

### 4. Conversation Memory (Sliding Window + Summarization)

- **File:** `src/services/memory/conversationMemory.js`
- Per-session memory using `Map<sessionId, {messages, summary}>`
- **Sliding window**: keeps the last N messages (configurable, default 20)
- **Optional summarization**: when history exceeds threshold, uses LLM to summarize older messages into a compact paragraph, preserving context while reducing token usage
- Supports multiple concurrent sessions (each WebSocket client gets isolated memory)

### 5. Deepgram TTS (Text-to-Speech)

- **File:** `src/services/deepgram/tts.js`
- Uses Deepgram's `speak.request()` API with the Aura Asteria voice model
- Output: raw linear16 audio at 24kHz sample rate
- Two modes: `synthesize()` returns full audio buffer, `streamSynthesize()` streams chunks via callback

### 6. WebSocket Streaming & Latency Optimization

- **File:** `src/ws/wsHandler.js` + `src/app.js`
- Binary WebSocket protocol: audio data sent as raw binary frames (no base64 encoding overhead)
- JSON messages for control signals (transcripts, status updates, errors)
- Audio chunked into 4KB segments with `setImmediate()` between chunks (non-blocking I/O)
- Heartbeat ping/pong every 30 seconds for connection health monitoring
- Streamed LLM responses (`streamAndCollect()`) for lower time-to-first-token

### 7. Error Handling & Reconnect Logic

- **Files:** All service files + `src/app.js`
- **STT reconnection**: exponential backoff (1s → 2s → 4s → 8s → 10s cap), max 5 attempts
- **LLM error handling**: try/catch on all API calls, fallback TTS error message sent to client
- **WebSocket**: dead connection detection via ping/pong, automatic cleanup on disconnect
- **Graceful shutdown**: handles SIGINT/SIGTERM, closes all connections, cleans up sessions
- **Uncaught exceptions & unhandled rejections**: caught at process level with logging

---

## Installation

### Prerequisites

- **Node.js** v18 or higher
- **Deepgram API Key** — [Get one here](https://console.deepgram.com) (free $200 credit)
- **Grok API Key** — [Get one here](https://console.x.ai)

### Steps

```bash
# 1. Clone the repository
git clone <repository-url>
cd voice-agent

# 2. Install dependencies
npm install

# 3. Create environment file
# Copy .env.example or create .env with your API keys (see Configuration below)
```

---

## Configuration

Create a `.env` file in the project root:

```env
# Deepgram API Key (Required) — used for both STT and TTS
DEEPGRAM_API_KEY=your_deepgram_api_key_here

# Grok API Key (Required) — used for LLM conversation
GROK_API_KEY=your_xai_api_key_here

# Server Config (Optional)
WS_PORT=8080

# Memory Settings (Optional)
MAX_CONVERSATION_HISTORY=20
USE_SUMMARIZATION=false
```

All settings can be fine-tuned in `src/config/config.js`:
| Setting | Default | Description |
|---------|---------|-------------|
| STT Model | `nova-2` | Deepgram transcription model |
| TTS Model | `aura-asteria-en` | Deepgram voice (female, natural) |
| LLM Model | `grok-3` | X.AI Grok model |
| LLM Temperature | `0.7` | Response creativity (0-1) |
| Max Tokens | `300` | Keep responses concise for voice |
| Memory Window | `20` | Messages kept in sliding window |
| Utterance End | `1000ms` | Silence threshold to finalize speech |

---

## Usage

```bash
# Start the server
npm start

# Or with auto-restart on file changes (development)
npm run dev
```

**Expected output:**

```
╔══════════════════════════════════════╗
║     🎙️  AI Voice Agent Starting      ║
╚══════════════════════════════════════╝

✅ Configuration validated
✅ [STT] Service ready
✅ [TTS] Service ready
✅ [LLM] Initialized with Grok (grok-3)
👤 [LLM] Persona: Nova - AI Voice Assistant
✅ [WS] Server listening on ws://localhost:8080

🎧 Waiting for client connections...
```

Then open `client.html` in your browser to start a voice conversation.

---

## Client Interface

The included `client.html` provides a browser-based test interface:

- **Start/Stop** button to begin/end voice capture
- **Real-time transcript** display (interim + final results)
- **AI response** text display
- **Audio playback** of TTS responses
- Captures microphone audio as linear16 at 16kHz
- Connects to `ws://localhost:8080` automatically

---

## Troubleshooting

| Issue                         | Solution                                            |
| ----------------------------- | --------------------------------------------------- |
| "Missing API keys" on startup | Check `.env` file exists with valid keys            |
| No transcripts appearing      | Ensure microphone permission is granted in browser  |
| LLM returns errors            | Verify your Grok API key starts with `xai-`         |
| Port 8080 already in use      | Change `WS_PORT` in `.env` or kill existing process |
| STT connection timeout        | Check internet connection and Deepgram API key      |
| Audio not playing in browser  | Use Chrome/Edge (best Web Audio API support)        |
