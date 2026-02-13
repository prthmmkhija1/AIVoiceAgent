"""
LLM Provider Service (Multi-Provider)

Supports Grok (X.AI), OpenAI, and Anthropic for conversation handling.
Grok & OpenAI use the OpenAI-compatible SDK; Anthropic uses its own SDK.
Injects persona system prompt into every request.
Supports both regular and streaming responses.
Includes automatic retry with exponential backoff for resilience.
"""

import asyncio
import logging
import random
from typing import AsyncGenerator, List, Dict

from openai import AsyncOpenAI

from app.config import config
from app.services.llm.persona import persona

logger = logging.getLogger(__name__)


# ─── Retry helper (inlined) ─────────────────────────────────

async def _with_retry(fn, max_retries=3, initial_delay_ms=500,
                      max_delay_ms=3000, backoff_multiplier=2, name="LLM"):
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


class LLMProvider:
    """
    Unified LLM provider supporting Grok, OpenAI, and Anthropic.

    Provider is selected via ``config["llm"]["provider"]``:
        - ``"grok"``      → X.AI (OpenAI-compatible)
        - ``"openai"``    → OpenAI directly
        - ``"anthropic"`` → Anthropic Messages API
    """

    def __init__(self):
        llm_cfg = config["llm"]
        self.provider = llm_cfg.get("provider", "grok")
        self.model = llm_cfg["model"]
        self.system_prompt = persona.get_system_prompt()

        # ── Initialise the right client ──────────────────────
        if self.provider in ("grok", "groq", "openai"):
            api_key = (
                config["grok_api_key"] if self.provider == "grok"
                else config["groq_api_key"] if self.provider == "groq"
                else config["openai_api_key"]
            )
            base_url = llm_cfg.get("base_url")
            kwargs = {"api_key": api_key}
            if base_url:
                kwargs["base_url"] = base_url
            self.openai_client = AsyncOpenAI(**kwargs)
            self.anthropic_client = None
        elif self.provider == "anthropic":
            try:
                from anthropic import AsyncAnthropic
            except ImportError:
                raise ImportError(
                    "Anthropic provider selected but 'anthropic' package is not installed.\n"
                    "Install it with: pip install anthropic>=0.20.0"
                )
            self.anthropic_client = AsyncAnthropic(
                api_key=config["anthropic_api_key"],
            )
            self.openai_client = None
        else:
            raise ValueError(f"Unsupported LLM provider: {self.provider}")

        logger.info(
            "✅ [LLM] Initialized with %s (%s)",
            self.provider.upper(), self.model,
        )
        logger.info("👤 [LLM] Persona: %s - %s", persona.name, persona.role)

    # ─────────────────────────────────────────────────────────
    # Public API (provider-agnostic)
    # ─────────────────────────────────────────────────────────

    async def generate_response(self, conversation_history: List[Dict[str, str]]) -> str:
        """Generate a complete response (non-streaming, with retry)."""

        if self.provider in ("grok", "groq", "openai"):
            return await self._openai_generate(conversation_history)
        else:
            return await self._anthropic_generate(conversation_history)

    async def stream_response(
        self, conversation_history: List[Dict[str, str]]
    ) -> AsyncGenerator[str, None]:
        """Stream a response token-by-token (lower latency for TTS)."""

        if self.provider in ("grok", "groq", "openai"):
            async for token in self._openai_stream(conversation_history):
                yield token
        else:
            async for token in self._anthropic_stream(conversation_history):
                yield token

    async def stream_and_collect(self, conversation_history: List[Dict[str, str]]) -> str:
        """Collect a full streamed response into a single string."""
        full = ""
        async for token in self.stream_response(conversation_history):
            full += token
        logger.info('🤖 [LLM] Streamed response: "%s..."', full[:80])
        return full

    async def summarize(self, messages: List[Dict[str, str]]) -> str:
        """Summarize a conversation history for memory compaction (with retry)."""
        summary_prompt = (
            "Summarize this conversation concisely, preserving key "
            "facts and context. Write it as a brief narrative paragraph."
        )
        formatted = "\n".join(f"{m['role']}: {m['content']}" for m in messages)

        if self.provider in ("grok", "groq", "openai"):
            async def _do():
                response = await self.openai_client.chat.completions.create(
                    model=self.model,
                    messages=[
                        {"role": "system", "content": summary_prompt},
                        {"role": "user", "content": formatted},
                    ],
                    temperature=0.3,
                    max_tokens=200,
                )
                return response.choices[0].message.content or ""
            return await _with_retry(_do, name="LLM-Summarize")
        else:
            async def _do():
                response = await self.anthropic_client.messages.create(
                    model=self.model,
                    system=summary_prompt,
                    messages=[{"role": "user", "content": formatted}],
                    temperature=0.3,
                    max_tokens=200,
                )
                return response.content[0].text
            return await _with_retry(_do, name="LLM-Summarize")

    # ─────────────────────────────────────────────────────────
    # OpenAI-compatible backend (Grok + OpenAI)
    # ─────────────────────────────────────────────────────────

    async def _openai_generate(self, conversation_history: List[Dict[str, str]]) -> str:
        async def _do():
            messages = [
                {"role": "system", "content": self.system_prompt},
                *conversation_history,
            ]
            response = await self.openai_client.chat.completions.create(
                model=self.model,
                messages=messages,
                temperature=config["llm"]["temperature"],
                max_tokens=config["llm"]["max_tokens"],
                stream=False,
            )
            content = response.choices[0].message.content
            if not content:
                raise RuntimeError("LLM returned empty response")
            logger.info('🤖 [LLM] Response: "%s..."', content[:80])
            return content

        return await _with_retry(_do, name="LLM")

    async def _openai_stream(
        self, conversation_history: List[Dict[str, str]]
    ) -> AsyncGenerator[str, None]:
        messages = [
            {"role": "system", "content": self.system_prompt},
            *conversation_history,
        ]

        async def _create_stream():
            return await self.openai_client.chat.completions.create(
                model=self.model,
                messages=messages,
                temperature=config["llm"]["temperature"],
                max_tokens=config["llm"]["max_tokens"],
                stream=True,
            )

        stream = await _with_retry(_create_stream, name="LLM-Stream")
        async for chunk in stream:
            content = chunk.choices[0].delta.content
            if content:
                yield content

    # ─────────────────────────────────────────────────────────
    # Anthropic backend
    # ─────────────────────────────────────────────────────────

    async def _anthropic_generate(self, conversation_history: List[Dict[str, str]]) -> str:
        async def _do():
            # Anthropic uses 'system' as a top-level param, not a message
            messages = self._to_anthropic_messages(conversation_history)
            response = await self.anthropic_client.messages.create(
                model=self.model,
                system=self.system_prompt,
                messages=messages,
                temperature=config["llm"]["temperature"],
                max_tokens=config["llm"]["max_tokens"],
            )
            content = response.content[0].text
            if not content:
                raise RuntimeError("LLM returned empty response")
            logger.info('🤖 [LLM] Response: "%s..."', content[:80])
            return content

        return await _with_retry(_do, name="LLM")

    async def _anthropic_stream(
        self, conversation_history: List[Dict[str, str]]
    ) -> AsyncGenerator[str, None]:
        messages = self._to_anthropic_messages(conversation_history)

        async def _create_stream():
            return self.anthropic_client.messages.stream(
                model=self.model,
                system=self.system_prompt,
                messages=messages,
                temperature=config["llm"]["temperature"],
                max_tokens=config["llm"]["max_tokens"],
            )

        stream_mgr = await _with_retry(_create_stream, name="LLM-Stream")
        async with stream_mgr as stream:
            async for text in stream.text_stream:
                yield text

    @staticmethod
    def _to_anthropic_messages(history: List[Dict[str, str]]) -> List[Dict[str, str]]:
        """
        Convert history to Anthropic format.
        Filters out any 'system' role messages (they go in the top-level param).
        Ensures messages alternate user/assistant as Anthropic requires.
        """
        # Keep system messages containing conversation summaries as user context
        result = []
        for m in history:
            if m["role"] in ("user", "assistant"):
                result.append(m)
            elif m["role"] == "system" and "summary" in m.get("content", "").lower():
                # Inject summary as a user message so Anthropic sees the context
                result.append({"role": "user", "content": f"[Context] {m['content']}"})
        filtered = result
        if not filtered:
            return [{"role": "user", "content": "Hello"}]
        # Anthropic requires first message to be from 'user'
        if filtered[0]["role"] != "user":
            filtered.insert(0, {"role": "user", "content": "(continuing conversation)"})
        return filtered
