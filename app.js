/**
 * AI Voice Agent - Main Application
 * 
 * Orchestrates all services to create a real-time voice conversation flow:
 * 
 *   Client Audio → WebSocket → Deepgram STT → Text
 *                                                ↓
 *   Client ← WebSocket ← Deepgram TTS ← Grok LLM (+ Persona + Memory)
 */

import { config, validateConfig } from './src/config/config.js';
import WebSocketHandler from './src/ws/wsHandler.js';
import DeepgramSTT from './src/services/deepgram/stt.js';
import DeepgramTTS from './src/services/deepgram/tts.js';
import LLMProvider from './src/services/llm/provider.js';
import ConversationMemory from './src/services/memory/conversationMemory.js';
import LatencyMetrics from './src/utils/metrics.js';

// ─── Global Services ────────────────────────────────────────
let wsHandler;
let tts;
let llm;
let memory;
let metrics;

/**
 * Main application entry point
 */
async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║     🎙️  AI Voice Agent Starting      ║');
  console.log('╚══════════════════════════════════════╝');
  console.log('');

  // 1. Validate configuration
  validateConfig();

  // 2. Initialize services
  tts = new DeepgramTTS();
  llm = new LLMProvider();
  memory = new ConversationMemory();
  metrics = new LatencyMetrics();
  wsHandler = new WebSocketHandler();

  console.log('✅ All services initialized');
  console.log('');

  // 3. Start WebSocket server and handle connections
  wsHandler.initialize(handleNewConnection);

  console.log('');
  console.log('📋 Configuration:');
  console.log(`   LLM: Grok (${config.llm.model})`);
  console.log(`   STT: Deepgram (${config.stt.model})`);
  console.log(`   TTS: Deepgram (${config.tts.model})`);
  console.log(`   Memory: ${config.memory.useSummarization ? 'Summarization' : 'Sliding Window'} (max ${config.memory.maxMessages})`);
  console.log(`   WebSocket: ws://localhost:${config.wsPort}`);
  console.log(`   Metrics: Enabled (latency tracking)`);
  console.log('');
  console.log('🎧 Waiting for client connections...');
}

/**
 * Handle a new WebSocket client connection
 * Sets up per-client STT, audio routing, and conversation handling
 * 
 * @param {WebSocket} ws - Client WebSocket
 * @param {string} sessionId - Unique session identifier
 */
async function handleNewConnection(ws, sessionId) {
  console.log(`\n🆕 [App] New session: ${sessionId}`);

  // Create conversation memory and metrics tracking for this session
  memory.createSession(sessionId);
  metrics.createSession(sessionId);

  // Create a per-client STT instance
  const stt = new DeepgramSTT();

  // Buffer to accumulate final transcripts into a complete utterance
  let utteranceBuffer = '';
  let isProcessing = false;  // Prevent overlapping LLM calls

  // Barge-in support: AbortController to cancel current response
  let currentAbortController = null;

  /**
   * Cancel any ongoing AI response (barge-in)
   */
  function abortCurrentResponse() {
    if (currentAbortController) {
      console.log(`⏹️ [App] Barge-in: Aborting current response for ${sessionId}`);
      currentAbortController.abort();
      currentAbortController = null;
      wsHandler.sendJSON(ws, { type: 'audio_interrupted' });
    }
  }

  try {
    // Initialize STT with transcript handler
    await stt.connect(
      // On transcript received
      (result) => {
        // Barge-in: If user starts speaking while AI is responding, interrupt
        if (isProcessing && result.text.trim().length > 0) {
          abortCurrentResponse();
        }

        // Send transcript to client for display
        wsHandler.sendTranscript(ws, result.text, result.isFinal);

        if (result.isFinal) {
          utteranceBuffer += (utteranceBuffer ? ' ' : '') + result.text;
        }
      },
      // On STT error — attempt reconnection
      async (error) => {
        console.error(`❌ [App] STT error for ${sessionId}:`, error.message || error);
        wsHandler.sendError(ws, 'Speech recognition error. Reconnecting...');

        try {
          await stt.reconnect();
        } catch (reconnectError) {
          wsHandler.sendError(ws, 'Speech recognition failed. Please reconnect.');
        }
      },
      // On utterance end — user stopped speaking, process the message
      async () => {
        if (utteranceBuffer.trim() && !isProcessing) {
          const userMessage = utteranceBuffer.trim();
          utteranceBuffer = '';
          isProcessing = true;

          // Start latency tracking for this request
          metrics.startRequest(sessionId);
          metrics.markSTTComplete(sessionId);

          // Create abort controller for this response
          currentAbortController = new AbortController();

          try {
            await processUserMessage(ws, sessionId, userMessage, currentAbortController.signal);
          } finally {
            isProcessing = false;
            currentAbortController = null;
          }
        }
      }
    );

    // Route incoming audio from client to STT
    wsHandler.onMessage(
      ws,
      // Binary audio data → send to Deepgram STT
      (audioBuffer) => {
        stt.sendAudio(audioBuffer);
      },
      // JSON control messages
      (message) => {
        switch (message.type) {
          case 'end':
            console.log(`🛑 [App] Session ending: ${sessionId}`);
            abortCurrentResponse();
            stt.disconnect();
            memory.clearSession(sessionId);
            metrics.clearSession(sessionId);
            break;
          case 'clear':
            console.log(`🗑️ [App] Clearing history: ${sessionId}`);
            abortCurrentResponse();
            memory.clearSession(sessionId);
            memory.createSession(sessionId);
            break;
          case 'interrupt':
            // Explicit barge-in request from client
            abortCurrentResponse();
            break;
          default:
            console.log(`📨 [App] Unknown message type: ${message.type}`);
        }
      }
    );

    // Cleanup when client disconnects
    ws.on('close', () => {
      abortCurrentResponse();
      stt.disconnect();
      
      // Log session statistics before cleanup
      const sessionStats = metrics.getSessionStats(sessionId);
      if (sessionStats && sessionStats.requestCount > 0) {
        console.log(`📊 [Metrics] Session ${sessionId} stats: ${sessionStats.requestCount} requests, avg E2E: ${sessionStats.avgLatency.endToEnd}ms`);
      }
      
      memory.clearSession(sessionId);
      metrics.clearSession(sessionId);
      console.log(`🧹 [App] Cleaned up session: ${sessionId}`);
    });

  } catch (error) {
    console.error(`❌ [App] Failed to setup session ${sessionId}:`, error.message);
    wsHandler.sendError(ws, 'Failed to initialize voice agent. Please try again.');
  }
}

/**
 * Process a complete user message through the conversation pipeline:
 * 1. Add to memory
 * 2. Stream LLM response sentence-by-sentence
 * 3. Convert each sentence to speech immediately (lower latency)
 * 4. Stream audio back to client
 * 
 * @param {WebSocket} ws - Client WebSocket
 * @param {string} sessionId 
 * @param {string} userMessage - Complete user utterance
 * @param {AbortSignal} abortSignal - Signal to abort processing (barge-in)
 */
async function processUserMessage(ws, sessionId, userMessage, abortSignal = null) {
  console.log(`\n👤 [User] ${userMessage}`);

  // Helper to check if we should abort
  const isAborted = () => abortSignal?.aborted === true;

  try {
    // 1. Store user message in memory
    memory.addMessage(sessionId, 'user', userMessage);

    // 2. Apply memory management (sliding window or summarization)
    if (config.memory.useSummarization) {
      await memory.summarizeAndCompact(sessionId, (msgs) => llm.summarize(msgs));
    } else {
      memory.applyWindow(sessionId);
    }

    // Check for barge-in
    if (isAborted()) {
      console.log(`⏹️ [App] Processing aborted before LLM call`);
      return;
    }

    // 3. Get conversation history
    const history = memory.getHistory(sessionId);

    // 4. Stream LLM response with sentence-level TTS
    wsHandler.sendJSON(ws, { type: 'thinking' });

    let fullResponse = '';
    let sentenceBuffer = '';
    let isFirstSentence = true;
    const sentenceEnders = /[.!?\n]/;

    // Signal audio streaming start
    wsHandler.sendJSON(ws, {
      type: 'audio_start',
      sampleRate: config.tts.sample_rate,
      encoding: config.tts.encoding,
    });

    // Stream LLM tokens and process sentence-by-sentence
    let isFirstToken = true;
    for await (const token of llm.streamResponse(history)) {
      // Track first token latency
      if (isFirstToken) {
        metrics.markLLMFirstToken(sessionId);
        isFirstToken = false;
      }

      // Check for barge-in
      if (isAborted()) {
        console.log(`⏹️ [App] Barge-in during LLM streaming`);
        wsHandler.sendJSON(ws, { type: 'audio_end' });
        // Still save partial response if any
        if (fullResponse.trim()) {
          memory.addMessage(sessionId, 'assistant', fullResponse + ' [interrupted]');
        }
        return;
      }

      fullResponse += token;
      sentenceBuffer += token;

      // Check if we have a complete sentence
      if (sentenceEnders.test(token) && sentenceBuffer.trim().length > 0) {
        const sentence = sentenceBuffer.trim();
        sentenceBuffer = '';

        if (isFirstSentence) {
          wsHandler.sendJSON(ws, { type: 'speaking' });
          isFirstSentence = false;
        }

        // Check for barge-in before TTS
        if (isAborted()) {
          console.log(`⏹️ [App] Barge-in before TTS`);
          break;
        }

        // Convert sentence to speech and stream immediately
        try {
          let isFirstChunkForSentence = true;
          await tts.streamSynthesize(
            sentence,
            (audioChunk) => {
              if (!isAborted()) {
                // Track first TTS chunk latency
                if (isFirstChunkForSentence) {
                  metrics.markTTSFirstChunk(sessionId);
                  isFirstChunkForSentence = false;
                }
                wsHandler.sendAudio(ws, audioChunk);
              }
            },
            () => {} // onDone - sentence complete
          );
        } catch (ttsError) {
          console.error(`❌ [TTS] Sentence synthesis failed:`, ttsError.message);
        }
      }
    }

    // Mark LLM complete (streaming finished)
    metrics.markLLMComplete(sessionId);

    // Process any remaining text in buffer (if not aborted)
    if (sentenceBuffer.trim().length > 0 && !isAborted()) {
      try {
        let isFirstChunkFinal = true;
        await tts.streamSynthesize(
          sentenceBuffer.trim(),
          (audioChunk) => {
            if (!isAborted()) {
              if (isFirstChunkFinal) {
                metrics.markTTSFirstChunk(sessionId);
                isFirstChunkFinal = false;
              }
              wsHandler.sendAudio(ws, audioChunk);
            }
          },
          () => {}
        );
      } catch (ttsError) {
        console.error(`❌ [TTS] Final sentence synthesis failed:`, ttsError.message);
      }
    }

    // Mark TTS complete and finalize metrics
    metrics.markTTSComplete(sessionId);
    metrics.finalizeRequest(sessionId);

    // Signal audio complete
    wsHandler.sendJSON(ws, { type: 'audio_end' });

    // 5. Store AI response in memory (even if partially completed)
    if (fullResponse.trim()) {
      memory.addMessage(sessionId, 'assistant', fullResponse);

      // 6. Send text response to client
      wsHandler.sendResponse(ws, fullResponse);
    }

    console.log(`🤖 [Nova] ${fullResponse}`);
    console.log(`📊 [App] Session ${sessionId}: ${memory.getMessageCount(sessionId)} messages in memory`);

  } catch (error) {
    console.error(`❌ [App] Processing error:`, error.message);
    wsHandler.sendError(ws, 'Sorry, something went wrong. Please try again.');

    // Try to send a fallback audio response
    try {
      const fallbackAudio = await tts.synthesize("I'm sorry, I had trouble processing that. Could you try again?");
      wsHandler.streamAudio(ws, fallbackAudio);
    } catch (ttsError) {
      // TTS also failed, just send text error
      console.error('❌ [App] Fallback TTS also failed:', ttsError.message);
    }
  }
}

// ─── GRACEFUL SHUTDOWN ──────────────────────────────────────────
function shutdown(signal) {
  console.log(`\n🛑 Received ${signal}. Shutting down gracefully...`);

  if (wsHandler) wsHandler.close();

  console.log('👋 Goodbye!');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (error) => {
  console.error('💥 Uncaught exception:', error);
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  console.error('💥 Unhandled rejection:', reason);
});

// ─── START ──────────────────────────────────────────────────────
main().catch((error) => {
  console.error('💥 Fatal error:', error);
  process.exit(1);
});
