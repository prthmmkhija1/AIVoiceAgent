import { createClient } from '@deepgram/sdk';
import { config } from '../../config/config.js';
import { withRetry } from '../../utils/retry.js';

/**
 * Deepgram Text-to-Speech (TTS) Service
 * 
 * Converts text responses from the LLM into natural-sounding speech audio.
 * Returns raw audio buffers that can be streamed via WebSocket to the client.
 * Includes automatic retry with exponential backoff for resilience.
 */
class DeepgramTTS {
  constructor() {
    this.client = createClient(config.deepgramApiKey);
    
    // Retry configuration for TTS requests
    this.retryConfig = {
      maxRetries: 3,
      initialDelayMs: 300,
      maxDelayMs: 2000,
      backoffMultiplier: 2,
    };
  }

  /**
   * Convert text to speech audio (with automatic retry)
   * @param {string} text - The text to convert to speech
   * @returns {Promise<Buffer>} - Raw audio buffer (linear16, 24kHz)
   */
  async synthesize(text) {
    if (!text || text.trim() === '') {
      throw new Error('TTS: Empty text provided');
    }

    return withRetry(
      async () => {
        const response = await this.client.speak.request(
          { text },
          {
            model: config.tts.model,
            encoding: config.tts.encoding,
            sample_rate: config.tts.sample_rate,
            container: config.tts.container,
          }
        );

        const stream = await response.getStream();
        if (!stream) {
          throw new Error('TTS: No audio stream returned');
        }

        // Collect all audio chunks into a single buffer
        const chunks = [];
        const reader = stream.getReader();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }

        const audioBuffer = Buffer.concat(chunks.map(c => Buffer.from(c)));
        console.log(`🔊 [TTS] Generated ${audioBuffer.length} bytes of audio`);
        return audioBuffer;
      },
      {
        config: this.retryConfig,
        operationName: 'TTS',
      }
    );
  }

  /**
   * Convert text to speech and stream audio chunks via callback (with retry)
   * Lower latency than synthesize() since audio starts playing before
   * the full response is generated.
   * 
   * @param {string} text - Text to convert
   * @param {Function} onChunk - Called with each audio chunk (Buffer)
   * @param {Function} onDone - Called when streaming is complete
   */
  async streamSynthesize(text, onChunk, onDone) {
    if (!text || text.trim() === '') {
      if (onDone) onDone();
      return;
    }

    return withRetry(
      async () => {
        const response = await this.client.speak.request(
          { text },
          {
            model: config.tts.model,
            encoding: config.tts.encoding,
            sample_rate: config.tts.sample_rate,
            container: config.tts.container,
          }
        );

        const stream = await response.getStream();
        if (!stream) {
          throw new Error('TTS: No audio stream returned');
        }

        const reader = stream.getReader();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = Buffer.from(value);
          if (onChunk) onChunk(chunk);
        }

        console.log('🔊 [TTS] Stream complete');
        if (onDone) onDone();
      },
      {
        config: this.retryConfig,
        operationName: 'TTS-Stream',
      }
    );
  }
}

export default DeepgramTTS;
