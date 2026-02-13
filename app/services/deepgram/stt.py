"""
Deepgram Speech-to-Text (STT) Service

Handles real-time audio transcription using Deepgram's streaming API.
Audio chunks are sent via a persistent WebSocket connection to Deepgram,
and transcription results (interim + final) are emitted via callbacks.
"""

import asyncio
import logging
import random

from deepgram import DeepgramClient, LiveOptions, LiveTranscriptionEvents

from app.config import config

logger = logging.getLogger(__name__)


class DeepgramSTT:
    def __init__(self):
        self.client = DeepgramClient(config["deepgram_api_key"])
        self.connection = None
        self.is_connected = False
        self.on_transcript_callback = None
        self.on_error_callback = None
        self.on_utterance_end_callback = None

    async def connect(self, on_transcript, on_error, on_utterance_end):
        """
        Initialize a streaming STT connection to Deepgram.
        Waits for the connection to actually open before resolving.

        Args:
            on_transcript: Called with dict { text, is_final, speech_final, confidence }
            on_error: Called when an error occurs
            on_utterance_end: Called when user stops speaking
        """
        self.on_transcript_callback = on_transcript
        self.on_error_callback = on_error
        self.on_utterance_end_callback = on_utterance_end

        try:
            self.connection = self.client.listen.asyncwebsocket.v("1")

            # Set up event handlers before starting
            self._setup_event_handlers()

            stt_cfg = config["stt"]
            options = LiveOptions(
                model=stt_cfg["model"],
                language=stt_cfg["language"],
                smart_format=stt_cfg["smart_format"],
                punctuate=stt_cfg["punctuate"],
                interim_results=stt_cfg["interim_results"],
                utterance_end_ms=str(stt_cfg["utterance_end_ms"]),
                vad_events=stt_cfg["vad_events"],
                encoding=stt_cfg["encoding"],
                sample_rate=stt_cfg["sample_rate"],
            )

            started = await self.connection.start(options)
            if not started:
                raise RuntimeError("STT connection failed to start")

            self.is_connected = True
            logger.info("✅ [STT] Deepgram connection opened")

            # Start keepalive task to prevent Deepgram timeout
            self._keepalive_task = asyncio.create_task(self._keepalive_loop())

            return self.connection

        except Exception as e:
            logger.error("❌ [STT] Failed to connect: %s", e)
            raise

    def _setup_event_handlers(self):
        """Set up event handlers for the Deepgram STT connection."""

        async def on_transcript(conn, result, **kwargs):
            # Debug: log full result structure
            logger.info("🔍 [STT] Result type: %s", type(result).__name__)
            logger.info("🔍 [STT] Result attrs: %s", [a for a in dir(result) if not a.startswith('_')])
            alternatives = result.channel.alternatives
            if not alternatives:
                return
            transcript = alternatives[0].transcript
            if not transcript or transcript.strip() == "":
                return

            data = {
                "text": transcript,
                "is_final": result.is_final,
                "speech_final": result.speech_final,
                "confidence": alternatives[0].confidence or 0,
            }

            kind = "FINAL" if data["is_final"] else "interim"
            logger.info('📝 [STT] %s: "%s"', kind, data["text"])

            if self.on_transcript_callback:
                await self.on_transcript_callback(data)

        async def on_utterance_end(conn, *args, **kwargs):
            logger.info("🔇 [STT] Utterance ended (silence detected)")
            if self.on_utterance_end_callback:
                await self.on_utterance_end_callback()

        async def on_speech_started(conn, *args, **kwargs):
            logger.info("🎤 [STT] Speech detected")

        async def on_error(conn, error=None, **kwargs):
            logger.error("❌ [STT] Error: %s", error)
            self.is_connected = False
            if self.on_error_callback:
                await self.on_error_callback(error)

        async def on_close(conn, *args, **kwargs):
            logger.info("🔌 [STT] Connection closed")
            self.is_connected = False

        async def on_metadata(conn, *args, **kwargs):
            logger.info("📊 [STT] Metadata received")

        self.connection.on(LiveTranscriptionEvents.Transcript, on_transcript)
        self.connection.on(LiveTranscriptionEvents.UtteranceEnd, on_utterance_end)
        self.connection.on(LiveTranscriptionEvents.SpeechStarted, on_speech_started)
        self.connection.on(LiveTranscriptionEvents.Error, on_error)
        self.connection.on(LiveTranscriptionEvents.Close, on_close)
        self.connection.on(LiveTranscriptionEvents.Metadata, on_metadata)

    async def _keepalive_loop(self):
        """Send keepalive messages to Deepgram to prevent timeout."""
        try:
            while self.is_connected and self.connection:
                await asyncio.sleep(8)
                if self.is_connected and self.connection:
                    try:
                        await self.connection.keep_alive()
                        logger.debug("💓 [STT] Keepalive sent")
                    except Exception:
                        pass
        except asyncio.CancelledError:
            pass

    async def send_audio(self, audio_data: bytes) -> bool:
        """
        Send an audio chunk to Deepgram for transcription.

        Args:
            audio_data: Raw audio data (linear16, 16 kHz)
        """
        if not self.connection or not self.is_connected:
            logger.warning("⚠️ [STT] Cannot send audio: not connected")
            return False
        try:
            await self.connection.send(audio_data)
            return True
        except Exception as e:
            logger.error("❌ [STT] Failed to send audio: %s", e)
            return False

    async def disconnect(self):
        """Close the STT connection."""
        # Cancel keepalive task
        if hasattr(self, '_keepalive_task') and self._keepalive_task:
            self._keepalive_task.cancel()
            try:
                await self._keepalive_task
            except (asyncio.CancelledError, Exception):
                pass
            self._keepalive_task = None

        if self.connection:
            try:
                await self.connection.finish()
            except Exception:
                pass
            self.connection = None
            self.is_connected = False
            logger.info("🔌 [STT] Disconnected")

    async def reconnect(self, max_attempts: int = 5):
        """Reconnect with iterative exponential backoff + jitter."""
        for attempt in range(1, max_attempts + 1):
            delay = min(1.0 * (2 ** (attempt - 1)), 10.0)
            jitter = delay * 0.2 * (2 * random.random() - 1)
            wait = delay + jitter
            logger.info(
                "🔄 [STT] Reconnecting in %.1fs (attempt %d/%d)...",
                wait, attempt, max_attempts,
            )
            await asyncio.sleep(wait)

            try:
                await self.disconnect()
                await self.connect(
                    self.on_transcript_callback,
                    self.on_error_callback,
                    self.on_utterance_end_callback,
                )
                logger.info("✅ [STT] Reconnected successfully")
                return
            except Exception as e:
                logger.error("❌ [STT] Reconnection attempt %d failed: %s", attempt, e)

        raise RuntimeError("STT reconnection failed after %d attempts" % max_attempts)
