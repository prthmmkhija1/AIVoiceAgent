/**
 * Latency Metrics Tracker
 * 
 * Tracks timing for different stages of the voice conversation pipeline:
 *   Speech End → STT → LLM → TTS → Playback
 * 
 * Provides insights for optimization and debugging.
 */

class LatencyMetrics {
  constructor() {
    // Store metrics by session
    this.sessions = new Map();
    
    // Rolling window of recent timings for averages
    this.recentTimings = {
      stt: [],
      llmFirstToken: [],
      llmComplete: [],
      ttsFirstChunk: [],
      ttsComplete: [],
      endToEnd: [],
    };
    
    this.maxRecentSamples = 50;
  }

  /**
   * Initialize metrics tracking for a session
   * @param {string} sessionId 
   */
  createSession(sessionId) {
    this.sessions.set(sessionId, {
      currentRequest: null,
      requestCount: 0,
      totalLatency: {
        stt: 0,
        llmFirstToken: 0,
        llmComplete: 0,
        ttsFirstChunk: 0,
        ttsComplete: 0,
        endToEnd: 0,
      },
    });
  }

  /**
   * Clean up session metrics
   * @param {string} sessionId 
   */
  clearSession(sessionId) {
    this.sessions.delete(sessionId);
  }

  /**
   * Start timing a new request (user finished speaking)
   * @param {string} sessionId 
   * @returns {string} - Request ID for tracking
   */
  startRequest(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const requestId = `${sessionId}-${Date.now()}`;
    session.currentRequest = {
      id: requestId,
      startTime: performance.now(),
      timestamps: {
        userSpeechEnd: performance.now(),
        sttComplete: null,
        llmFirstToken: null,
        llmComplete: null,
        ttsFirstChunk: null,
        ttsComplete: null,
        audioPlaybackStart: null,
      },
    };
    session.requestCount++;

    return requestId;
  }

  /**
   * Mark STT completion
   * @param {string} sessionId 
   */
  markSTTComplete(sessionId) {
    const req = this._getRequest(sessionId);
    if (!req) return;
    req.timestamps.sttComplete = performance.now();
  }

  /**
   * Mark first LLM token received
   * @param {string} sessionId 
   */
  markLLMFirstToken(sessionId) {
    const req = this._getRequest(sessionId);
    if (!req || req.timestamps.llmFirstToken) return;  // Only first
    req.timestamps.llmFirstToken = performance.now();
  }

  /**
   * Mark LLM response complete
   * @param {string} sessionId 
   */
  markLLMComplete(sessionId) {
    const req = this._getRequest(sessionId);
    if (!req) return;
    req.timestamps.llmComplete = performance.now();
  }

  /**
   * Mark first TTS audio chunk sent
   * @param {string} sessionId 
   */
  markTTSFirstChunk(sessionId) {
    const req = this._getRequest(sessionId);
    if (!req || req.timestamps.ttsFirstChunk) return;  // Only first
    req.timestamps.ttsFirstChunk = performance.now();
  }

  /**
   * Mark TTS complete
   * @param {string} sessionId 
   */
  markTTSComplete(sessionId) {
    const req = this._getRequest(sessionId);
    if (!req) return;
    req.timestamps.ttsComplete = performance.now();
  }

  /**
   * Finalize request and calculate latencies
   * @param {string} sessionId 
   * @returns {Object} - Latency breakdown in milliseconds
   */
  finalizeRequest(sessionId) {
    const session = this.sessions.get(sessionId);
    const req = session?.currentRequest;
    if (!req) return null;

    const t = req.timestamps;
    const start = t.userSpeechEnd;

    const latencies = {
      stt: t.sttComplete ? Math.round(t.sttComplete - start) : null,
      llmFirstToken: t.llmFirstToken ? Math.round(t.llmFirstToken - (t.sttComplete || start)) : null,
      llmComplete: t.llmComplete ? Math.round(t.llmComplete - (t.sttComplete || start)) : null,
      ttsFirstChunk: t.ttsFirstChunk ? Math.round(t.ttsFirstChunk - (t.llmComplete || start)) : null,
      ttsComplete: t.ttsComplete ? Math.round(t.ttsComplete - (t.llmComplete || start)) : null,
      endToEnd: t.ttsComplete ? Math.round(t.ttsComplete - start) : null,
    };

    // Update rolling averages
    for (const [key, value] of Object.entries(latencies)) {
      if (value !== null && this.recentTimings[key]) {
        this.recentTimings[key].push(value);
        if (this.recentTimings[key].length > this.maxRecentSamples) {
          this.recentTimings[key].shift();
        }
        session.totalLatency[key] += value;
      }
    }

    // Log the latency breakdown
    this._logLatencies(sessionId, latencies);

    session.currentRequest = null;
    return latencies;
  }

  /**
   * Get average latencies across recent requests
   * @returns {Object} - Average latencies in milliseconds
   */
  getAverages() {
    const averages = {};
    for (const [key, samples] of Object.entries(this.recentTimings)) {
      if (samples.length > 0) {
        averages[key] = Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
      } else {
        averages[key] = null;
      }
    }
    return averages;
  }

  /**
   * Get session statistics
   * @param {string} sessionId 
   * @returns {Object}
   */
  getSessionStats(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.requestCount === 0) return null;

    return {
      requestCount: session.requestCount,
      avgLatency: {
        stt: Math.round(session.totalLatency.stt / session.requestCount),
        llmFirstToken: Math.round(session.totalLatency.llmFirstToken / session.requestCount),
        llmComplete: Math.round(session.totalLatency.llmComplete / session.requestCount),
        ttsFirstChunk: Math.round(session.totalLatency.ttsFirstChunk / session.requestCount),
        endToEnd: Math.round(session.totalLatency.endToEnd / session.requestCount),
      },
    };
  }

  /**
   * Log latency breakdown with visual formatting
   */
  _logLatencies(sessionId, latencies) {
    const parts = [];
    
    if (latencies.stt !== null) parts.push(`STT: ${latencies.stt}ms`);
    if (latencies.llmFirstToken !== null) parts.push(`LLM→1st: ${latencies.llmFirstToken}ms`);
    if (latencies.llmComplete !== null) parts.push(`LLM: ${latencies.llmComplete}ms`);
    if (latencies.ttsFirstChunk !== null) parts.push(`TTS→1st: ${latencies.ttsFirstChunk}ms`);
    if (latencies.endToEnd !== null) parts.push(`E2E: ${latencies.endToEnd}ms`);

    const breakdown = parts.join(' | ');
    
    // Color code by end-to-end latency
    const e2e = latencies.endToEnd;
    let icon = '📊';
    if (e2e !== null) {
      if (e2e < 1500) icon = '🟢';        // Excellent
      else if (e2e < 3000) icon = '🟡';   // Good
      else if (e2e < 5000) icon = '🟠';   // Acceptable
      else icon = '🔴';                    // Slow
    }

    console.log(`${icon} [Latency] ${breakdown}`);
  }

  /**
   * Get current request object
   * @private
   */
  _getRequest(sessionId) {
    return this.sessions.get(sessionId)?.currentRequest;
  }
}

export default LatencyMetrics;
