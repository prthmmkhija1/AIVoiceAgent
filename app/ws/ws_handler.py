"""
WebSocket Handler

Manages the WebSocket server for real-time bidirectional communication.
Handles client connections, audio streaming, and message routing.

Communication protocol:
  Client → Server:
    - Binary data = audio chunks (sent to Deepgram STT)
    - JSON text   = control messages (e.g., { type: 'end' })

  Server → Client:
    - Binary data = TTS audio chunks
    - JSON text   = transcripts, status updates, errors
"""

import asyncio
import json
import logging
import uuid
from typing import Callable, Coroutine, Dict, Optional, Set

import websockets
from websockets.server import WebSocketServerProtocol

from app.config import config

logger = logging.getLogger(__name__)


class WebSocketHandler:
    def __init__(self):
        self.server = None
        self.clients: Dict[WebSocketServerProtocol, dict] = {}
        self._on_connection: Optional[Callable] = None

    async def initialize(self, on_connection: Callable):
        """
        Start the WebSocket server.

        Args:
            on_connection: Async callable (ws, session_id) for each new client.
        """
        self._on_connection = on_connection
        self.server = await websockets.serve(
            self._handle_connection,
            "0.0.0.0",
            config["ws_port"],
            ping_interval=30,
            ping_timeout=10,
        )
        logger.info("✅ [WS] Server listening on ws://localhost:%d", config["ws_port"])

    async def _handle_connection(self, ws: WebSocketServerProtocol, path: str = "/"):
        session_id = str(uuid.uuid4())
        client_ip = ws.remote_address[0] if ws.remote_address else "unknown"

        self.clients[ws] = {"session_id": session_id, "is_alive": True}
        logger.info("🔌 [WS] Client connected: %s (%s)", session_id, client_ip)

        # Send welcome message
        await self.send_json(ws, {
            "type": "connected",
            "sessionId": session_id,
            "message": "Connected to AI Voice Agent",
        })

        # Notify app about the new connection
        if self._on_connection:
            await self._on_connection(ws, session_id)

    # ─── Send helpers ────────────────────────────────────────

    async def send_json(self, ws: WebSocketServerProtocol, data: dict):
        """Send JSON message to client."""
        try:
            await ws.send(json.dumps(data))
        except websockets.exceptions.ConnectionClosed:
            pass

    async def send_audio(self, ws: WebSocketServerProtocol, audio_buffer: bytes):
        """Send audio buffer to client (binary)."""
        try:
            await ws.send(audio_buffer)
        except websockets.exceptions.ConnectionClosed:
            pass

    async def stream_audio(
        self, ws: WebSocketServerProtocol, audio_buffer: bytes, chunk_size: int = 4096
    ):
        """
        Stream audio to client in chunks for lower latency.
        Sends audio_start → audio chunks → audio_end.
        """
        tts_cfg = config["tts"]
        await self.send_json(ws, {
            "type": "audio_start",
            "sampleRate": tts_cfg["sample_rate"],
            "encoding": tts_cfg["encoding"],
            "totalBytes": len(audio_buffer),
        })

        offset = 0
        while offset < len(audio_buffer):
            chunk = audio_buffer[offset: offset + chunk_size]
            try:
                await ws.send(chunk)
            except websockets.exceptions.ConnectionClosed:
                return
            offset += chunk_size
            await asyncio.sleep(0)  # yield to event loop

        await self.send_json(ws, {"type": "audio_end"})

    async def send_transcript(self, ws, text: str, is_final: bool):
        await self.send_json(ws, {"type": "transcript", "text": text, "isFinal": is_final})

    async def send_response(self, ws, text: str):
        await self.send_json(ws, {"type": "response", "text": text})

    async def send_error(self, ws, message: str):
        await self.send_json(ws, {"type": "error", "message": message})

    # ─── Session helpers ─────────────────────────────────────

    def get_session_id(self, ws) -> Optional[str]:
        info = self.clients.get(ws)
        return info["session_id"] if info else None

    def remove_client(self, ws):
        self.clients.pop(ws, None)

    async def close(self):
        """Close all connections and shut down the server."""
        for ws in list(self.clients):
            try:
                await ws.close(1001, "Server shutting down")
            except Exception:
                pass
        self.clients.clear()
        if self.server:
            self.server.close()
            await self.server.wait_closed()
            logger.info("🔌 [WS] Server closed")
            self.server = None
