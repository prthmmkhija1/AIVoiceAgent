"""
Deepgram Text-to-Speech (TTS) Service

Converts text responses from the LLM into natural-sounding speech audio.
Returns raw audio buffers that can be streamed via WebSocket to the client.
Includes automatic retry with exponential backoff for resilience.
"""

import asyncio
import logging
import random
from typing import Callable, Optional

from deepgram import DeepgramClient, SpeakOptions

from app.config import config

logger = logging.getLogger(__name__)


# ─── Retry helper (inlined) ─────────────────────────────────

async def _with_retry(fn, max_retries=3, initial_delay_ms=300,
                      max_delay_ms=2000, backoff_multiplier=2, name="TTS"):
    """Execute *fn* with exponential-backoff retry."""
    last_err = None
    for attempt in range(max_retries + 1):
        try:
            return await fn()
        except Exception as exc:
            last_err = exc
            if attempt == max_retries:
                logger.error("❌ [%s] Failed after %d attempts: %s", name, max_retries + 1, exc)
                raise
            delay = min(initial_delay_ms * (backoff_multiplier ** attempt), max_delay_ms)
            jitter = delay * 0.2 * (random.random() * 2 - 1)
            wait = (delay + jitter) / 1000.0
            logger.warning("⚠️ [%s] Attempt %d failed: %s. Retrying in %.2fs…",
                           name, attempt + 1, exc, wait)
            await asyncio.sleep(wait)
    raise last_err  # type: ignore[misc]


class DeepgramTTS:
    def __init__(self):
        self.client = DeepgramClient(config["deepgram_api_key"])

    async def synthesize(self, text: str) -> bytes:
        """
        Convert text to speech audio (with automatic retry).

        Args:
            text: The text to convert to speech.

        Returns:
            Raw audio bytes (linear16, 24 kHz).
        """
        if not text or text.strip() == "":
            raise ValueError("TTS: Empty text provided")

        async def _do():
            tts_cfg = config["tts"]
            options = SpeakOptions(
                model=tts_cfg["model"],
                encoding=tts_cfg["encoding"],
                sample_rate=tts_cfg["sample_rate"],
                container=tts_cfg["container"],
            )
            response = await self.client.speak.asyncrest.v("1").stream_memory(
                {"text": text}, options
            )
            audio_data = response.stream.read()
            logger.info("🔊 [TTS] Generated %d bytes of audio", len(audio_data))
            return audio_data

        return await _with_retry(_do, name="TTS")

    async def stream_synthesize(
        self,
        text: str,
        on_chunk: Optional[Callable[[bytes], None]] = None,
        on_done: Optional[Callable[[], None]] = None,
    ):
        """
        Convert text to speech and stream audio chunks via callback.
        Lower latency than synthesize() since audio starts playing before
        the full response is generated.

        Args:
            text: Text to convert.
            on_chunk: Called with each audio chunk (bytes).
            on_done: Called when streaming is complete.
        """
        if not text or text.strip() == "":
            if on_done:
                on_done()
            return

        async def _do():
            tts_cfg = config["tts"]
            options = SpeakOptions(
                model=tts_cfg["model"],
                encoding=tts_cfg["encoding"],
                sample_rate=tts_cfg["sample_rate"],
                container=tts_cfg["container"],
            )
            response = await self.client.speak.asyncrest.v("1").stream_memory(
                {"text": text}, options
            )
            # Read in chunks
            chunk_size = 4096
            while True:
                chunk = response.stream.read(chunk_size)
                if not chunk:
                    break
                if on_chunk:
                    on_chunk(chunk)

            logger.info("🔊 [TTS] Stream complete")
            if on_done:
                on_done()

        await _with_retry(_do, name="TTS-Stream")
