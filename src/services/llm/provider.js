import OpenAI from 'openai';
import { config } from '../../config/config.js';
import persona from './persona.js';

/**
 * LLM Provider Service (Grok via X.AI)
 * 
 * Handles all communication with the Grok LLM.
 * Uses OpenAI-compatible API format (X.AI provides this).
 * Injects persona system prompt into every request.
 * Supports both regular and streaming responses.
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

    console.log(`✅ [LLM] Initialized with Grok (${this.model})`);
    console.log(`👤 [LLM] Persona: ${persona.name} - ${persona.role}`);
  }

  /**
   * Generate a complete response (non-streaming)
   * @param {Array} conversationHistory - Array of { role, content } messages
   * @returns {Promise<string>} - The LLM response text
   */
  async generateResponse(conversationHistory) {
    try {
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
    } catch (error) {
      console.error('❌ [LLM] Generation failed:', error.message);
      throw error;
    }
  }

  /**
   * Stream a response token-by-token (lower latency for TTS)
   * @param {Array} conversationHistory - Array of { role, content } messages
   * @yields {string} - Individual text chunks as they arrive
   */
  async *streamResponse(conversationHistory) {
    try {
      const messages = [
        { role: 'system', content: this.systemPrompt },
        ...conversationHistory,
      ];

      const stream = await this.client.chat.completions.create({
        model: this.model,
        messages,
        temperature: config.llm.temperature,
        max_tokens: config.llm.maxTokens,
        stream: true,
      });

      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content;
        if (content) {
          yield content;
        }
      }
    } catch (error) {
      console.error('❌ [LLM] Streaming failed:', error.message);
      throw error;
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
   * Summarize a conversation history for memory compaction
   * @param {Array} messages - Messages to summarize
   * @returns {Promise<string>} - Summary text
   */
  async summarize(messages) {
    try {
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
    } catch (error) {
      console.error('❌ [LLM] Summarization failed:', error.message);
      throw error;
    }
  }
}

export default LLMProvider;
