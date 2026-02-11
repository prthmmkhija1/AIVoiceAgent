import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import { config } from '../../config/config.js';

/**
 * Deepgram Speech-to-Text (STT) Service
 * 
 * Handles real-time audio transcription using Deepgram's streaming API.
 * Audio chunks are sent via a persistent WebSocket connection to Deepgram,
 * and transcription results (interim + final) are emitted via callbacks.
 */
class DeepgramSTT {
  constructor() {
    this.client = createClient(config.deepgramApiKey);
    this.connection = null;
    this.isConnected = false;
    this.onTranscriptCallback = null;
    this.onErrorCallback = null;
    this.onUtteranceEndCallback = null;
  }

  /**
   * Initialize a streaming STT connection to Deepgram
   * Waits for the connection to actually open before resolving.
   * @param {Function} onTranscript - Called with { text, isFinal, speechFinal }
   * @param {Function} onError - Called when an error occurs
   * @param {Function} onUtteranceEnd - Called when user stops speaking
   */
  async connect(onTranscript, onError, onUtteranceEnd) {
    this.onTranscriptCallback = onTranscript;
    this.onErrorCallback = onError;
    this.onUtteranceEndCallback = onUtteranceEnd;

    try {
      this.connection = this.client.listen.live({
        model: config.stt.model,
        language: config.stt.language,
        smart_format: config.stt.smart_format,
        punctuate: config.stt.punctuate,
        interim_results: config.stt.interim_results,
        utterance_end_ms: config.stt.utterance_end_ms,
        vad_events: config.stt.vad_events,
        encoding: config.stt.encoding,
        sample_rate: config.stt.sample_rate,
      });

      // Wait for the connection to actually open
      await this._waitForOpen();

      return this.connection;
    } catch (error) {
      console.error('❌ [STT] Failed to connect:', error.message);
      throw error;
    }
  }

  /**
   * Wait for the Deepgram WebSocket to open before sending audio
   */
  _waitForOpen() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('STT connection timeout (10s)'));
      }, 10000);

      this.connection.on(LiveTranscriptionEvents.Open, () => {
        clearTimeout(timeout);
        console.log('✅ [STT] Deepgram connection opened');
        this.isConnected = true;
        this._setupEventHandlers();
        resolve();
      });

      this.connection.on(LiveTranscriptionEvents.Error, (error) => {
        clearTimeout(timeout);
        console.error('❌ [STT] Connection error during setup:', error);
        reject(error);
      });
    });
  }

  /**
   * Set up event handlers for the Deepgram STT connection
   */
  _setupEventHandlers() {
    // Transcription result received
    this.connection.on(LiveTranscriptionEvents.Transcript, (data) => {
      const alternative = data.channel?.alternatives?.[0];
      const transcript = alternative?.transcript;
      if (!transcript || transcript.trim() === '') return;

      const result = {
        text: transcript,
        isFinal: data.is_final,
        speechFinal: data.speech_final,
        confidence: alternative?.confidence || 0,
      };

      console.log(`📝 [STT] ${result.isFinal ? 'FINAL' : 'interim'}: "${result.text}"`);

      if (this.onTranscriptCallback) {
        this.onTranscriptCallback(result);
      }
    });

    // Utterance end — user stopped speaking (silence detected)
    this.connection.on(LiveTranscriptionEvents.UtteranceEnd, () => {
      console.log('🔇 [STT] Utterance ended (silence detected)');
      if (this.onUtteranceEndCallback) {
        this.onUtteranceEndCallback();
      }
    });

    // Speech started
    this.connection.on(LiveTranscriptionEvents.SpeechStarted, () => {
      console.log('🎤 [STT] Speech detected');
    });

    // Error
    this.connection.on(LiveTranscriptionEvents.Error, (error) => {
      console.error('❌ [STT] Error:', error);
      this.isConnected = false;
      if (this.onErrorCallback) this.onErrorCallback(error);
    });

    // Connection closed
    this.connection.on(LiveTranscriptionEvents.Close, () => {
      console.log('🔌 [STT] Connection closed');
      this.isConnected = false;
    });

    // Metadata
    this.connection.on(LiveTranscriptionEvents.Metadata, (data) => {
      console.log('📊 [STT] Metadata received');
    });
  }

  /**
   * Send an audio chunk to Deepgram for transcription
   * @param {Buffer} audioData - Raw audio data (linear16, 16kHz)
   */
  sendAudio(audioData) {
    if (!this.connection || !this.isConnected) {
      console.warn('⚠️ [STT] Cannot send audio: not connected');
      return false;
    }

    try {
      this.connection.send(audioData);
      return true;
    } catch (error) {
      console.error('❌ [STT] Failed to send audio:', error.message);
      return false;
    }
  }

  /**
   * Close the STT connection
   */
  disconnect() {
    if (this.connection) {
      try {
        this.connection.finish();
      } catch (error) {
        // Connection may already be closed
      }
      this.connection = null;
      this.isConnected = false;
      console.log('🔌 [STT] Disconnected');
    }
  }

  /**
   * Reconnect with exponential backoff
   * @param {number} attempt - Current attempt number
   * @param {number} maxAttempts - Max reconnection attempts
   */
  async reconnect(attempt = 1, maxAttempts = 5) {
    if (attempt > maxAttempts) {
      console.error('❌ [STT] Max reconnection attempts reached');
      throw new Error('STT reconnection failed after max attempts');
    }

    const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
    console.log(`🔄 [STT] Reconnecting in ${delay}ms (attempt ${attempt}/${maxAttempts})...`);

    await new Promise(resolve => setTimeout(resolve, delay));

    try {
      this.disconnect();
      await this.connect(this.onTranscriptCallback, this.onErrorCallback, this.onUtteranceEndCallback);
      console.log('✅ [STT] Reconnected successfully');
    } catch (error) {
      console.error(`❌ [STT] Reconnection attempt ${attempt} failed:`, error.message);
      return this.reconnect(attempt + 1, maxAttempts);
    }
  }
}

export default DeepgramSTT;
