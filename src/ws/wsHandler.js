import { WebSocketServer } from 'ws';
import { randomUUID } from 'crypto';
import { config } from '../config/config.js';

/**
 * WebSocket Handler
 * 
 * Manages the WebSocket server for real-time bidirectional communication.
 * Handles client connections, audio streaming, and message routing.
 * 
 * Communication protocol:
 *   Client → Server:
 *     - Binary data = audio chunks (sent to Deepgram STT)
 *     - JSON text   = control messages (e.g., { type: 'end' })
 *   
 *   Server → Client:
 *     - Binary data = TTS audio chunks
 *     - JSON text   = transcripts, status updates, errors
 */
class WebSocketHandler {
  constructor() {
    this.wss = null;
    this.clients = new Map();  // Map<ws, { sessionId, isAlive }>
  }

  /**
   * Start the WebSocket server
   * @param {Function} onConnection - Called with (ws, sessionId) for each new client
   */
  initialize(onConnection) {
    this.wss = new WebSocketServer({ port: config.wsPort });

    this.wss.on('listening', () => {
      console.log(`✅ [WS] Server listening on ws://localhost:${config.wsPort}`);
    });

    this.wss.on('connection', (ws, req) => {
      const sessionId = randomUUID();
      const clientIp = req.socket.remoteAddress;

      // Store client info
      this.clients.set(ws, { sessionId, isAlive: true });
      console.log(`🔌 [WS] Client connected: ${sessionId} (${clientIp})`);

      // Setup ping/pong for connection health
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });

      // Handle disconnect
      ws.on('close', (code, reason) => {
        console.log(`🔌 [WS] Client disconnected: ${sessionId} (code: ${code})`);
        this.clients.delete(ws);
      });

      // Handle errors
      ws.on('error', (error) => {
        console.error(`❌ [WS] Client error (${sessionId}):`, error.message);
        this.clients.delete(ws);
      });

      // Send welcome
      this.sendJSON(ws, {
        type: 'connected',
        sessionId,
        message: 'Connected to AI Voice Agent',
      });

      // Notify the app about the new connection
      if (onConnection) {
        onConnection(ws, sessionId);
      }
    });

    this.wss.on('error', (error) => {
      console.error('❌ [WS] Server error:', error.message);
    });

    // Heartbeat check every 30 seconds
    this._startHeartbeat();
  }

  /**
   * Register a message handler for a specific client
   * Routes audio (binary) and control messages (JSON) separately
   * 
   * @param {WebSocket} ws - The client's WebSocket
   * @param {Function} onAudio - Called with (audioBuffer) for binary data
   * @param {Function} onControl - Called with (message) for JSON control messages
   */
  onMessage(ws, onAudio, onControl) {
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        // Binary = raw audio from client's microphone
        if (onAudio) onAudio(Buffer.from(data));
      } else {
        // Text = JSON control message
        try {
          const message = JSON.parse(data.toString());
          if (onControl) onControl(message);
        } catch (error) {
          console.error('❌ [WS] Invalid JSON message:', error.message);
        }
      }
    });
  }

  /**
   * Send JSON message to client
   * @param {WebSocket} ws 
   * @param {Object} data 
   */
  sendJSON(ws, data) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  /**
   * Send audio buffer to client (binary)
   * @param {WebSocket} ws 
   * @param {Buffer} audioBuffer 
   */
  sendAudio(ws, audioBuffer) {
    if (ws.readyState === ws.OPEN) {
      ws.send(audioBuffer);
    }
  }

  /**
   * Stream audio to client in chunks for lower latency
   * Sends audio_start → audio chunks → audio_end
   * 
   * @param {WebSocket} ws 
   * @param {Buffer} audioBuffer - Full audio buffer
   * @param {number} chunkSize - Size of each chunk (default 4KB)
   */
  streamAudio(ws, audioBuffer, chunkSize = 4096) {
    if (ws.readyState !== ws.OPEN) return;

    // Signal start
    this.sendJSON(ws, {
      type: 'audio_start',
      sampleRate: config.tts.sample_rate,
      encoding: config.tts.encoding,
      totalBytes: audioBuffer.length,
    });

    // Send in chunks
    let offset = 0;
    const sendNextChunk = () => {
      if (offset >= audioBuffer.length || ws.readyState !== ws.OPEN) {
        // Signal end
        this.sendJSON(ws, { type: 'audio_end' });
        return;
      }

      const chunk = audioBuffer.slice(offset, offset + chunkSize);
      ws.send(chunk);
      offset += chunkSize;

      // Non-blocking: yield to event loop between chunks
      setImmediate(sendNextChunk);
    };

    sendNextChunk();
  }

  /**
   * Send a transcript event to client
   * @param {WebSocket} ws 
   * @param {string} text - Transcript text
   * @param {boolean} isFinal - Whether this is a final transcript
   */
  sendTranscript(ws, text, isFinal) {
    this.sendJSON(ws, {
      type: 'transcript',
      text,
      isFinal,
    });
  }

  /**
   * Send AI response text to client
   * @param {WebSocket} ws 
   * @param {string} text - AI response text
   */
  sendResponse(ws, text) {
    this.sendJSON(ws, {
      type: 'response',
      text,
    });
  }

  /**
   * Send error to client
   * @param {WebSocket} ws 
   * @param {string} message 
   */
  sendError(ws, message) {
    this.sendJSON(ws, {
      type: 'error',
      message,
    });
  }

  /**
   * Get session ID for a WebSocket connection
   * @param {WebSocket} ws 
   * @returns {string|null}
   */
  getSessionId(ws) {
    return this.clients.get(ws)?.sessionId || null;
  }

  /**
   * Heartbeat to detect broken connections
   */
  _startHeartbeat() {
    const interval = setInterval(() => {
      if (!this.wss) {
        clearInterval(interval);
        return;
      }

      this.wss.clients.forEach(ws => {
        if (!ws.isAlive) {
          console.log('💀 [WS] Terminating dead connection');
          this.clients.delete(ws);
          return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
      });
    }, 30000);
  }

  /**
   * Close all connections and shut down server
   */
  close() {
    // Close all client connections
    this.clients.forEach((info, ws) => {
      ws.close(1001, 'Server shutting down');
    });
    this.clients.clear();

    // Close server
    if (this.wss) {
      this.wss.close(() => {
        console.log('🔌 [WS] Server closed');
      });
      this.wss = null;
    }
  }
}

export default WebSocketHandler;
