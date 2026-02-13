"""
Central configuration for the AI Voice Agent.
Loads settings from environment variables and defines defaults for all services.
Supports multiple LLM providers: Grok (X.AI), Groq, OpenAI, and Anthropic.
"""

import os
import sys

from dotenv import load_dotenv

load_dotenv()

# Determine LLM provider from env (grok | groq | openai | anthropic)
_llm_provider = os.getenv("LLM_PROVIDER", "grok").lower()

# Provider-specific model defaults
_MODEL_DEFAULTS = {
    "grok": "grok-3",
    "groq": "llama-3.3-70b-versatile",
    "openai": "gpt-4o",
    "anthropic": "claude-sonnet-4-20250514",
}

_BASE_URL_DEFAULTS = {
    "grok": "https://api.x.ai/v1",
    "groq": "https://api.groq.com/openai/v1",
    "openai": "https://api.openai.com/v1",
    "anthropic": None,  # Anthropic SDK uses its own base URL
}

config = {
    # ─── API KEYS ──────────────────────────────────────────────
    "deepgram_api_key": os.getenv("DEEPGRAM_API_KEY", ""),
    "grok_api_key": os.getenv("GROK_API_KEY", ""),
    "groq_api_key": os.getenv("GROQ_API_KEY", ""),
    "openai_api_key": os.getenv("OPENAI_API_KEY", ""),
    "anthropic_api_key": os.getenv("ANTHROPIC_API_KEY", ""),

    # ─── SERVER CONFIG ─────────────────────────────────────────
    "ws_port": int(os.getenv("WS_PORT", "8080")),

    # ─── DEEPGRAM STT SETTINGS ────────────────────────────────
    "stt": {
        "model": "nova-2",
        "language": "en",
        "smart_format": True,
        "punctuate": True,
        "interim_results": True,
        "utterance_end_ms": 1000,
        "vad_events": True,
        "encoding": "linear16",
        "sample_rate": 16000,
    },

    # ─── DEEPGRAM TTS SETTINGS ────────────────────────────────
    "tts": {
        "model": "aura-asteria-en",
        "encoding": "linear16",
        "sample_rate": 24000,
        "container": "none",
    },

    # ─── LLM SETTINGS (multi-provider) ────────────────────────
    "llm": {
        "provider": _llm_provider,
        "model": os.getenv("LLM_MODEL", _MODEL_DEFAULTS.get(_llm_provider, "gpt-4o")),
        "base_url": os.getenv("LLM_BASE_URL", _BASE_URL_DEFAULTS.get(_llm_provider)),
        "temperature": float(os.getenv("LLM_TEMPERATURE", "0.7")),
        "max_tokens": int(os.getenv("LLM_MAX_TOKENS", "300")),
        "stream": True,
    },

    # ─── CONVERSATION MEMORY SETTINGS ─────────────────────────
    "memory": {
        "max_messages": 20,
        "use_summarization": False,
        "summarize_after": 15,
    },
}

# Map provider → config key for the API key
_PROVIDER_KEY_MAP = {
    "grok": "grok_api_key",
    "groq": "groq_api_key",
    "openai": "openai_api_key",
    "anthropic": "anthropic_api_key",
}


def validate_config():
    """Validate that all required API keys are present."""
    missing = []

    if not config["deepgram_api_key"]:
        missing.append("DEEPGRAM_API_KEY")

    # Only require the API key for the selected LLM provider
    provider = config["llm"]["provider"]
    key_name = _PROVIDER_KEY_MAP.get(provider)
    if key_name and not config.get(key_name):
        env_var = key_name.upper()
        missing.append(env_var)

    if missing:
        print(f"❌ Missing required API keys: {', '.join(missing)}")
        print(f"   LLM provider: {provider}")
        print("   Create a .env file with these keys.")
        sys.exit(1)

    print(f"✅ Configuration validated (LLM provider: {provider})")
