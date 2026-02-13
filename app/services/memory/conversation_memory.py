"""
Conversation Memory Service

Stores and manages conversation history for each session.
Supports multiple concurrent sessions (one per WebSocket client).
Uses sliding window to keep memory bounded.
Optionally uses LLM summarization for context compaction.
"""

import logging
import time
from typing import Callable, Coroutine, Dict, List, Optional

from app.config import config

logger = logging.getLogger(__name__)


class ConversationMemory:
    def __init__(self):
        # sessionId -> { messages, summary, created_at }
        self.sessions: Dict[str, dict] = {}

    def create_session(self, session_id: str):
        """Initialize a new session."""
        self.sessions[session_id] = {
            "messages": [],
            "summary": "",
            "created_at": time.time(),
        }
        logger.info("📝 [Memory] Session created: %s", session_id)

    def add_message(self, session_id: str, role: str, content: str):
        """Add a message to conversation history."""
        session = self.sessions.get(session_id)
        if session is None:
            logger.warning("⚠️ [Memory] Session not found: %s", session_id)
            return
        session["messages"].append({
            "role": role,
            "content": content,
            "timestamp": time.time(),
        })
        logger.info('📝 [Memory] [%s] %s: "%s..."', session_id, role, content[:60])

    def get_history(self, session_id: str) -> List[Dict[str, str]]:
        """
        Get conversation history for LLM (applies sliding window).
        Returns messages formatted for the LLM API.
        """
        session = self.sessions.get(session_id)
        if session is None:
            return []

        messages: List[Dict[str, str]] = []

        if session["summary"]:
            messages.append({
                "role": "system",
                "content": f"Previous conversation summary: {session['summary']}",
            })

        window_size = config["memory"]["max_messages"]
        recent = session["messages"][-window_size:]
        for m in recent:
            messages.append({"role": m["role"], "content": m["content"]})
        return messages

    def apply_window(self, session_id: str):
        """Apply sliding window — remove oldest messages beyond the limit."""
        session = self.sessions.get(session_id)
        if session is None:
            return
        max_msgs = config["memory"]["max_messages"]
        if len(session["messages"]) > max_msgs:
            removed = len(session["messages"]) - max_msgs
            session["messages"] = session["messages"][-max_msgs:]
            logger.info("📝 [Memory] Sliding window: removed %d old messages", removed)

    async def summarize_and_compact(
        self,
        session_id: str,
        summarize_fn: Callable[[List[Dict[str, str]]], Coroutine],
    ):
        """Summarize old messages and compact memory using the LLM."""
        session = self.sessions.get(session_id)
        if session is None:
            return

        threshold = config["memory"]["summarize_after"]
        if len(session["messages"]) <= threshold:
            return

        keep_recent = threshold // 2
        to_summarize = session["messages"][:-keep_recent]
        to_keep = session["messages"][-keep_recent:]

        try:
            summary = await summarize_fn(to_summarize)
            session["summary"] = (
                f"{session['summary']}\n\nUpdate: {summary}"
                if session["summary"]
                else summary
            )
            session["messages"] = to_keep
            logger.info(
                "📝 [Memory] Summarized %d messages, keeping %d",
                len(to_summarize), len(to_keep),
            )
        except Exception as e:
            logger.error("❌ [Memory] Summarization failed: %s", e)
            self.apply_window(session_id)

    def get_message_count(self, session_id: str) -> int:
        session = self.sessions.get(session_id)
        return len(session["messages"]) if session else 0

    def clear_session(self, session_id: str):
        if session_id in self.sessions:
            del self.sessions[session_id]
            logger.info("🗑️ [Memory] Session cleared: %s", session_id)

    def get_active_sessions(self) -> List[str]:
        return list(self.sessions.keys())
