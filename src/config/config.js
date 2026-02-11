import dotenv from 'dotenv';
dotenv.config();

export const config = {
  // ─── API KEYS ──────────────────────────────────────────────
  // 🔑 Deepgram API Key (used for BOTH STT and TTS)
  //    Get it from: https://console.deepgram.com → Settings → API Keys
  deepgramApiKey: process.env.DEEPGRAM_API_KEY,

  // 🔑 Grok API Key (used for LLM conversation)
  //    Get it from: https://console.x.ai → API Keys
  grokApiKey: process.env.GROK_API_KEY,

  // ─── SERVER CONFIG ─────────────────────────────────────────
  wsPort: parseInt(process.env.WS_PORT) || 8080,

  // ─── DEEPGRAM STT SETTINGS ────────────────────────────────
  stt: {
    model: 'nova-2',           // Best accuracy model
    language: 'en',
    smart_format: true,        // Auto-punctuation, formatting
    punctuate: true,
    interim_results: true,     // Get partial results for lower latency
    utterance_end_ms: 1000,    // Silence duration to finalize utterance
    vad_events: true,          // Voice Activity Detection
    encoding: 'linear16',
    sample_rate: 16000,
  },

  // ─── DEEPGRAM TTS SETTINGS ────────────────────────────────
  tts: {
    model: 'aura-asteria-en',  // Female voice (natural sounding)
    encoding: 'linear16',
    sample_rate: 24000,
    container: 'none',         // Raw audio (no container format)
  },

  // ─── GROK (X.AI) LLM SETTINGS ──────────────────────────────
  llm: {
    model: 'grok-3',                   // Grok-3 via X.AI
    baseURL: 'https://api.x.ai/v1',
    temperature: 0.7,
    maxTokens: 300,            // Keep short for voice responses
    stream: true,              // Stream for lower latency
  },

  // ─── CONVERSATION MEMORY SETTINGS ─────────────────────────
  memory: {
    maxMessages: 20,           // Sliding window size
    useSummarization: false,   // Toggle summarization vs sliding window
    summarizeAfter: 15,        // Summarize when history exceeds this
  },
};

// ─── VALIDATION ────────────────────────────────────────────
export function validateConfig() {
  const missing = [];
  if (!config.deepgramApiKey) missing.push('DEEPGRAM_API_KEY');
  if (!config.grokApiKey) missing.push('GROK_API_KEY');

  if (missing.length > 0) {
    console.error(`❌ Missing required API keys: ${missing.join(', ')}`);
    console.error(`   Create a .env file with these keys. See .env.example`);
    process.exit(1);
  }

  console.log('✅ Configuration validated');
}
