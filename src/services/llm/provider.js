import OpenAI from 'openai';
import { config } from '../../config/config.js';
import persona from './persona.js';
import { withRetry } from '../../utils/retry.js';

/**
 * LLM Provider Service (Grok via X.AI)
 * 
 * Handles all communication with the Grok LLM.
 * Uses OpenAI-compatible API format (X.AI provides this).
 * Injects persona system prompt into every request.
 * Supports both regular and streaming responses.
 * Includes automatic retry with exponential backoff for resilience.
 */
class LLMProvider {
  constructor() {
    // Grok (X.AI) uses OpenAI-compatible API
    this.client = new OpenAI({
      apiKey: config.grokApiKey,
      baseURL: config.llm.baseURL,   // https://api.x.ai/v1
    });

    this.model = config.llm.model;
    this.systemPrompt = persona.getSystemPrompt();

    // Retry configuration for LLM requests
    this.retryConfig = {
      maxRetries: 3,
      initialDelayMs: 500,
      maxDelayMs: 3000,
      backoffMultiplier: 2,
    };

    console.log(`✅ [LLM] Initialized with Grok (${this.model})`);
    console.log(`👤 [LLM] Persona: ${persona.name} - ${persona.role}`);
  }

  /**
   * Generate a complete response (non-streaming, with retry)
   * @param {Array} conversationHistory - Array of { role, content } messages
   * @returns {Promise<string>} - The LLM response text
   */
  async generateResponse(conversationHistory) {
    return withRetry(
      async () => {
        const messages = [
          { role: 'system', content: this.systemPrompt },
          ...conversationHistory,
        ];

        const response = await this.client.chat.completions.create({
          model: this.model,
          messages,
          temperature: config.llm.temperature,
          max_tokens: config.llm.maxTokens,
          stream: false,
        });

        const content = response.choices[0]?.message?.content;
        if (!content) {
          throw new Error('LLM returned empty response');
        }

        console.log(`🤖 [LLM] Response: "${content.substring(0, 80)}..."`);
        return content;
      },
      {
        config: this.retryConfig,
        operationName: 'LLM',
      }
    );
  }

  /**
   * Stream a response token-by-token (lower latency for TTS)
   * Connection attempt is retried, then streaming proceeds.
   * @param {Array} conversationHistory - Array of { role, content } messages
   * @yields {string} - Individual text chunks as they arrive
   */
  async *streamResponse(conversationHistory) {
    const messages = [
      { role: 'system', content: this.systemPrompt },
      ...conversationHistory,
    ];

    // Retry the initial connection, then stream
    const stream = await withRetry(
      async () => {
        return await this.client.chat.completions.create({
          model: this.model,
          messages,
          temperature: config.llm.temperature,
          max_tokens: config.llm.maxTokens,
          stream: true,
        });
      },
      {
        config: this.retryConfig,
        operationName: 'LLM-Stream',
      }
    );

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        yield content;
      }
    }
  }

  /**
   * Collect a full streamed response into a single string
   * (Useful when you need the complete text for TTS)
   * @param {Array} conversationHistory 
   * @returns {Promise<string>} 
   */
  async streamAndCollect(conversationHistory) {
    let fullResponse = '';
    for await (const chunk of this.streamResponse(conversationHistory)) {
      fullResponse += chunk;
    }
    console.log(`🤖 [LLM] Streamed response: "${fullResponse.substring(0, 80)}..."`);
    return fullResponse;
  }

  /**
   * Summarize a conversation history for memory compaction (with retry)
   * @param {Array} messages - Messages to summarize
   * @returns {Promise<string>} - Summary text
   */
  async summarize(messages) {
    return withRetry(
      async () => {
        const formatted = messages
          .map(m => `${m.role}: ${m.content}`)
          .join('\n');

        const response = await this.client.chat.completions.create({
          model: this.model,
          messages: [
            {
              role: 'system',
              content: 'Summarize this conversation concisely, preserving key facts and context. Write it as a brief narrative paragraph.',
            },
            { role: 'user', content: formatted },
          ],
          temperature: 0.3,
          max_tokens: 200,
        });

        return response.choices[0]?.message?.content || '';
      },
      {
        config: this.retryConfig,
        operationName: 'LLM-Summarize',
      }
    );
  }
}

export default LLMProvider;
