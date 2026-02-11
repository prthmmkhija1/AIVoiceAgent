/**
 * AI Voice Agent - Main Application
 * 
 * Orchestrates all services to create a real-time voice conversation flow:
 * 
 *   Client Audio → WebSocket → Deepgram STT → Text
 *                                                ↓
 *   Client ← WebSocket ← Deepgram TTS ← Grok LLM (+ Persona + Memory)
 */

import { config, validateConfig } from './config/config.js';
import WebSocketHandler from './ws/wsHandler.js';
import DeepgramSTT from './services/deepgram/stt.js';
import DeepgramTTS from './services/deepgram/tts.js';
import LLMProvider from './services/llm/provider.js';
import ConversationMemory from './services/memory/conversationMemory.js';

// ─── Global Services ────────────────────────────────────────
let wsHandler;
let tts;
let llm;
let memory;

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

  // Create conversation memory for this session
  memory.createSession(sessionId);

  // Create a per-client STT instance
  const stt = new DeepgramSTT();

  // Buffer to accumulate final transcripts into a complete utterance
  let utteranceBuffer = '';
  let isProcessing = false;  // Prevent overlapping LLM calls

  try {
    // Initialize STT with transcript handler
    await stt.connect(
      // On transcript received
      (result) => {
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

          try {
            await processUserMessage(ws, sessionId, userMessage);
          } finally {
            isProcessing = false;
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
            stt.disconnect();
            memory.clearSession(sessionId);
            break;
          case 'clear':
            console.log(`🗑️ [App] Clearing history: ${sessionId}`);
            memory.clearSession(sessionId);
            memory.createSession(sessionId);
            break;
          default:
            console.log(`📨 [App] Unknown message type: ${message.type}`);
        }
      }
    );

    // Cleanup when client disconnects
    ws.on('close', () => {
      stt.disconnect();
      memory.clearSession(sessionId);
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
 * 2. Send to LLM (with persona + history)
 * 3. Convert response to speech
 * 4. Stream audio back to client
 * 
 * @param {WebSocket} ws - Client WebSocket
 * @param {string} sessionId 
 * @param {string} userMessage - Complete user utterance
 */
async function processUserMessage(ws, sessionId, userMessage) {
  console.log(`\n👤 [User] ${userMessage}`);

  try {
    // 1. Store user message in memory
    memory.addMessage(sessionId, 'user', userMessage);

    // 2. Apply memory management (sliding window or summarization)
    if (config.memory.useSummarization) {
      await memory.summarizeAndCompact(sessionId, (msgs) => llm.summarize(msgs));
    } else {
      memory.applyWindow(sessionId);
    }

    // 3. Get conversation history
    const history = memory.getHistory(sessionId);

    // 4. Generate LLM response
    wsHandler.sendJSON(ws, { type: 'thinking' });
    const aiResponse = await llm.streamAndCollect(history);

    // 5. Store AI response in memory
    memory.addMessage(sessionId, 'assistant', aiResponse);

    // 6. Send text response to client
    wsHandler.sendResponse(ws, aiResponse);

    // 7. Convert to speech with Deepgram TTS
    wsHandler.sendJSON(ws, { type: 'speaking' });
    const audioBuffer = await tts.synthesize(aiResponse);

    // 8. Stream audio to client
    wsHandler.streamAudio(ws, audioBuffer);

    console.log(`🤖 [Nova] ${aiResponse}`);
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
