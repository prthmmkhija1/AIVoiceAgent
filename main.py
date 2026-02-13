"""
AI Voice Agent — Main Application

Orchestrates all services to create a real-time voice conversation flow:

  Client Audio → WebSocket → Deepgram STT → Text
                                              ↓
  Client ← WebSocket ← Deepgram TTS ← Grok LLM (+ Persona + Memory)
"""

import asyncio
import json
import logging
import re
import signal
import sys
import time as _time

import websockets

from app.config import config, validate_config
from app.ws.ws_handler import WebSocketHandler
from app.services.deepgram.stt import DeepgramSTT
from app.services.deepgram.tts import DeepgramTTS
from app.services.llm.provider import LLMProvider
from app.services.memory.conversation_memory import ConversationMemory

# ─── Logging Setup ───────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)


# ─── Latency Metrics (inlined) ───────────────────────────────

class LatencyMetrics:
    """Tracks timing for the voice pipeline: STT → LLM → TTS."""

    def __init__(self):
        self.sessions = {}

    def create_session(self, sid):
        self.sessions[sid] = {"cur": None, "n": 0, "totals": {
            "stt": 0, "llm_first_token": 0, "llm_complete": 0,
            "tts_first_chunk": 0, "tts_complete": 0, "end_to_end": 0}}

    def clear_session(self, sid):
        self.sessions.pop(sid, None)

    def start_request(self, sid):
        s = self.sessions.get(sid)
        if not s:
            return
        now = _time.perf_counter()
        s["cur"] = {"start": now, "stt": None, "llm1": None, "llmc": None, "tts1": None, "ttsc": None}
        s["n"] += 1

    def _ts(self, sid):
        s = self.sessions.get(sid)
        return s["cur"] if s else None

    def mark_stt_complete(self, sid):
        c = self._ts(sid)
        if c:
            c["stt"] = _time.perf_counter()

    def mark_llm_first_token(self, sid):
        c = self._ts(sid)
        if c and c["llm1"] is None:
            c["llm1"] = _time.perf_counter()

    def mark_llm_complete(self, sid):
        c = self._ts(sid)
        if c:
            c["llmc"] = _time.perf_counter()

    def mark_tts_first_chunk(self, sid):
        c = self._ts(sid)
        if c and c["tts1"] is None:
            c["tts1"] = _time.perf_counter()

    def mark_tts_complete(self, sid):
        c = self._ts(sid)
        if c:
            c["ttsc"] = _time.perf_counter()

    def finalize_request(self, sid):
        s = self.sessions.get(sid)
        c = s["cur"] if s else None
        if not c:
            return
        st = c["start"]

        def _ms(v, ref):
            return round((v - ref) * 1000) if v else None

        lat = {
            "stt": _ms(c["stt"], st),
            "llm_first_token": _ms(c["llm1"], c["stt"] or st),
            "llm_complete": _ms(c["llmc"], c["stt"] or st),
            "tts_first_chunk": _ms(c["tts1"], c["llmc"] or st),
            "end_to_end": _ms(c["ttsc"], st),
        }
        parts = []
        for key, label in [("stt", "STT"), ("llm_first_token", "LLM→1st"),
                           ("llm_complete", "LLM"), ("tts_first_chunk", "TTS→1st"),
                           ("end_to_end", "E2E")]:
            v = lat.get(key)
            if v is not None:
                parts.append(f"{label}: {v}ms")
                s["totals"][key] = s["totals"].get(key, 0) + v
        e2e = lat.get("end_to_end")
        icon = "📊"
        if e2e is not None:
            icon = "🟢" if e2e < 1500 else "🟡" if e2e < 3000 else "🟠" if e2e < 5000 else "🔴"
        logger.info("%s [Latency] %s", icon, " | ".join(parts))
        s["cur"] = None

    def get_session_stats(self, sid):
        s = self.sessions.get(sid)
        if not s or s["n"] == 0:
            return None
        n = s["n"]
        return {"request_count": n, "avg_latency": {k: round(v / n) for k, v in s["totals"].items()}}

# ─── Global Services ─────────────────────────────────────────
ws_handler: WebSocketHandler = None  # type: ignore
tts: DeepgramTTS = None  # type: ignore
llm: LLMProvider = None  # type: ignore
memory: ConversationMemory = None  # type: ignore
metrics: LatencyMetrics = None  # type: ignore


# ──────────────────────────────────────────────────────────────
# Connection handler
# ──────────────────────────────────────────────────────────────

async def handle_new_connection(ws, session_id: str):
    """
    Handle a new WebSocket client connection.
    Sets up per-client STT, audio routing, and conversation handling.
    """
    logger.info("\n🆕 [App] New session: %s", session_id)

    memory.create_session(session_id)
    metrics.create_session(session_id)

    stt = DeepgramSTT()

    utterance_buffer = ""
    is_processing = False
    abort_event = asyncio.Event()

    def abort_current_response():
        nonlocal abort_event
        if abort_event.is_set():
            return
        if is_processing:
            logger.info("⏹️ [App] Barge-in: Aborting current response for %s", session_id)
            abort_event.set()
            asyncio.ensure_future(ws_handler.send_json(ws, {"type": "audio_interrupted"}))

    try:
        # ── STT callbacks ────────────────────────────────────

        async def on_transcript(result: dict):
            nonlocal utterance_buffer, is_processing
            # Barge-in check
            if is_processing and result["text"].strip():
                abort_current_response()

            await ws_handler.send_transcript(ws, result["text"], result["is_final"])
            if result["is_final"]:
                sep = " " if utterance_buffer else ""
                utterance_buffer += sep + result["text"]

                # If speech_final is True, process immediately
                # (don't wait for UtteranceEnd which may not fire)
                if result.get("speech_final"):
                    logger.info("🔇 [App] speech_final detected, processing...")
                    await on_utterance_end()

        async def on_stt_error(error):
            logger.error("❌ [App] STT error for %s: %s", session_id, error)
            await ws_handler.send_error(ws, "Speech recognition error. Reconnecting...")
            try:
                await stt.reconnect()
            except Exception:
                await ws_handler.send_error(ws, "Speech recognition failed. Please reconnect.")

        async def on_utterance_end():
            nonlocal utterance_buffer, is_processing, abort_event
            if utterance_buffer.strip() and not is_processing:
                user_message = utterance_buffer.strip()
                utterance_buffer = ""
                is_processing = True

                metrics.start_request(session_id)
                metrics.mark_stt_complete(session_id)

                abort_event = asyncio.Event()

                try:
                    await process_user_message(ws, session_id, user_message, abort_event)
                finally:
                    is_processing = False
                    # After barge-in, the new utterance's on_utterance_end may
                    # have fired while is_processing was True, orphaning the
                    # buffer. Re-check and process it now.
                    if utterance_buffer.strip():
                        pending = utterance_buffer.strip()
                        utterance_buffer = ""
                        is_processing = True
                        abort_event = asyncio.Event()
                        metrics.start_request(session_id)
                        metrics.mark_stt_complete(session_id)
                        try:
                            await process_user_message(
                                ws, session_id, pending, abort_event
                            )
                        finally:
                            is_processing = False

        # Connect STT
        await stt.connect(on_transcript, on_stt_error, on_utterance_end)

        # ── Message loop ─────────────────────────────────────

        async for raw_message in ws:
            if isinstance(raw_message, bytes):
                # Binary = raw audio from client's microphone
                await stt.send_audio(raw_message)
            else:
                # Text = JSON control message
                try:
                    msg = json.loads(raw_message)
                except json.JSONDecodeError:
                    logger.error("❌ [WS] Invalid JSON message")
                    continue

                msg_type = msg.get("type")
                if msg_type == "end":
                    logger.info("🛑 [App] Session ending: %s", session_id)
                    abort_current_response()
                    await stt.disconnect()
                    memory.clear_session(session_id)
                    metrics.clear_session(session_id)
                    break
                elif msg_type == "clear":
                    logger.info("🗑️ [App] Clearing history: %s", session_id)
                    abort_current_response()
                    memory.clear_session(session_id)
                    memory.create_session(session_id)
                elif msg_type == "interrupt":
                    abort_current_response()
                else:
                    logger.info("📨 [App] Unknown message type: %s", msg_type)

    except websockets.exceptions.ConnectionClosed:
        pass
    except Exception as e:
        logger.error("❌ [App] Failed to setup session %s: %s", session_id, e)
        await ws_handler.send_error(ws, "Failed to initialize voice agent. Please try again.")
    finally:
        abort_current_response()
        await stt.disconnect()

        stats = metrics.get_session_stats(session_id)
        if stats and stats["request_count"] > 0:
            logger.info(
                "📊 [Metrics] Session %s stats: %d requests, avg E2E: %sms",
                session_id, stats["request_count"], stats["avg_latency"].get("end_to_end"),
            )

        memory.clear_session(session_id)
        metrics.clear_session(session_id)
        ws_handler.remove_client(ws)
        logger.info("🧹 [App] Cleaned up session: %s", session_id)


# ──────────────────────────────────────────────────────────────
# Process user message
# ──────────────────────────────────────────────────────────────

# Match sentence-ending punctuation, but not mid-word dots (e.g. "3.5", "Dr.")
# Requires the dot/!/? to be followed by a space, end-of-string, or newline.
SENTENCE_ENDERS = re.compile(r'[.!?](?=\s|$)|\n')


async def process_user_message(ws, session_id: str, user_message: str, abort_event: asyncio.Event):
    """
    Process a complete user message through the conversation pipeline:
      1. Add to memory
      2. Stream LLM response sentence-by-sentence
      3. Convert each sentence to speech immediately (lower latency)
      4. Stream audio back to client
    """
    logger.info("\n👤 [User] %s", user_message)

    def is_aborted() -> bool:
        return abort_event.is_set()

    try:
        # 1. Store user message
        memory.add_message(session_id, "user", user_message)

        # 2. Memory management
        if config["memory"]["use_summarization"]:
            await memory.summarize_and_compact(session_id, llm.summarize)
        else:
            memory.apply_window(session_id)

        if is_aborted():
            logger.info("⏹️ [App] Processing aborted before LLM call")
            return

        # 3. Get history
        history = memory.get_history(session_id)

        # 4. Stream LLM response with sentence-level TTS
        await ws_handler.send_json(ws, {"type": "thinking"})

        full_response = ""
        sentence_buffer = ""
        is_first_sentence = True
        is_first_token = True

        await ws_handler.send_json(ws, {
            "type": "audio_start",
            "sampleRate": config["tts"]["sample_rate"],
            "encoding": config["tts"]["encoding"],
        })

        async for token in llm.stream_response(history):
            if is_first_token:
                metrics.mark_llm_first_token(session_id)
                is_first_token = False

            if is_aborted():
                logger.info("⏹️ [App] Barge-in during LLM streaming")
                await ws_handler.send_json(ws, {"type": "audio_end"})
                if full_response.strip():
                    memory.add_message(session_id, "assistant", full_response + " [interrupted]")
                return

            full_response += token
            sentence_buffer += token

            # Check for complete sentence
            if SENTENCE_ENDERS.search(token) and sentence_buffer.strip():
                sentence = sentence_buffer.strip()
                sentence_buffer = ""

                if is_first_sentence:
                    await ws_handler.send_json(ws, {"type": "speaking"})
                    is_first_sentence = False

                if is_aborted():
                    logger.info("⏹️ [App] Barge-in before TTS")
                    break

                # TTS for the sentence
                try:
                    audio_data = await tts.synthesize(sentence)
                    if not is_aborted() and audio_data:
                        metrics.mark_tts_first_chunk(session_id)
                        # Stream in chunks for lower latency
                        offset = 0
                        while offset < len(audio_data):
                            chunk = audio_data[offset:offset + 4096]
                            await ws_handler.send_audio(ws, chunk)
                            offset += 4096
                except Exception as e:
                    logger.error("❌ [TTS] Sentence synthesis failed: %s", e)

        # Mark LLM complete
        metrics.mark_llm_complete(session_id)

        # Remaining buffer
        if sentence_buffer.strip() and not is_aborted():
            try:
                audio_data = await tts.synthesize(sentence_buffer.strip())
                if not is_aborted() and audio_data:
                    metrics.mark_tts_first_chunk(session_id)
                    offset = 0
                    while offset < len(audio_data):
                        chunk = audio_data[offset:offset + 4096]
                        await ws_handler.send_audio(ws, chunk)
                        offset += 4096
            except Exception as e:
                logger.error("❌ [TTS] Final sentence synthesis failed: %s", e)

        metrics.mark_tts_complete(session_id)
        metrics.finalize_request(session_id)

        await ws_handler.send_json(ws, {"type": "audio_end"})

        if full_response.strip():
            memory.add_message(session_id, "assistant", full_response)
            await ws_handler.send_response(ws, full_response)

        logger.info("🤖 [Nova] %s", full_response)
        logger.info(
            "📊 [App] Session %s: %d messages in memory",
            session_id, memory.get_message_count(session_id),
        )

    except Exception as e:
        logger.error("❌ [App] Processing error: %s", e)
        await ws_handler.send_error(ws, "Sorry, something went wrong. Please try again.")
        try:
            fallback_audio = await tts.synthesize(
                "I'm sorry, I had trouble processing that. Could you try again?"
            )
            # Stream fallback audio in chunks (audio_start/end already sent)
            if fallback_audio:
                offset = 0
                while offset < len(fallback_audio):
                    chunk = fallback_audio[offset:offset + 4096]
                    await ws_handler.send_audio(ws, chunk)
                    offset += 4096
        except Exception as tts_err:
            logger.error("❌ [App] Fallback TTS also failed: %s", tts_err)


# ──────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────

async def main():
    global ws_handler, tts, llm, memory, metrics

    print()
    print("╔══════════════════════════════════════╗")
    print("║     🎙️  AI Voice Agent Starting      ║")
    print("╚══════════════════════════════════════╝")
    print()

    # 1. Validate configuration
    validate_config()

    # 2. Initialize services
    tts = DeepgramTTS()
    llm = LLMProvider()
    memory = ConversationMemory()
    metrics = LatencyMetrics()
    ws_handler = WebSocketHandler()

    logger.info("✅ All services initialized")
    print()

    # 3. Start WebSocket server
    await ws_handler.initialize(handle_new_connection)

    print()
    provider_name = config['llm']['provider'].upper()
    print("📋 Configuration:")
    print(f"   LLM: {provider_name} ({config['llm']['model']})")
    print(f"   STT: Deepgram ({config['stt']['model']})")
    print(f"   TTS: Deepgram ({config['tts']['model']})")
    mem_mode = "Summarization" if config["memory"]["use_summarization"] else "Sliding Window"
    print(f"   Memory: {mem_mode} (max {config['memory']['max_messages']})")
    print(f"   WebSocket: ws://localhost:{config['ws_port']}")
    print("   Metrics: Enabled (latency tracking)")
    print()
    print("🎧 Waiting for client connections...")

    # Keep the server running
    stop = asyncio.Event()

    def _shutdown():
        logger.info("\n🛑 Shutting down gracefully...")
        stop.set()

    loop = asyncio.get_event_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _shutdown)
        except NotImplementedError:
            # Windows: add_signal_handler not supported, use thread-based fallback
            import threading

            def _wait_for_ctrl_c():
                """Block in a background thread until Ctrl+C, then set the stop event."""
                try:
                    signal.signal(sig, lambda *_: None)  # reset default to avoid double KeyboardInterrupt
                except (OSError, ValueError):
                    pass
                import time
                while not stop.is_set():
                    try:
                        time.sleep(0.5)
                    except KeyboardInterrupt:
                        loop.call_soon_threadsafe(_shutdown)
                        return

            threading.Thread(target=_wait_for_ctrl_c, daemon=True).start()
            break  # only need one thread for Windows

    await stop.wait()
    await ws_handler.close()
    logger.info("👋 Goodbye!")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n👋 Goodbye!")
