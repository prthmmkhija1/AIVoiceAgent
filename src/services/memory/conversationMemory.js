/**
 * Conversation Memory Service
 * 
 * Stores and manages conversation history for each session.
 * Supports multiple concurrent sessions (one per WebSocket client).
 * Uses sliding window to keep memory bounded.
 * Optionally uses LLM summarization for context compaction.
 */

import { config } from '../../config/config.js';

class ConversationMemory {
  constructor() {
    // Map of sessionId → { messages: [], summary: '' }
    this.sessions = new Map();
  }

  /**
   * Initialize a new session
   * @param {string} sessionId 
   */
  createSession(sessionId) {
    this.sessions.set(sessionId, {
      messages: [],
      summary: '',        // Stores summarized older context
      createdAt: Date.now(),
    });
    console.log(`📝 [Memory] Session created: ${sessionId}`);
  }

  /**
   * Add a message to conversation history
   * @param {string} sessionId 
   * @param {string} role - 'user' or 'assistant'
   * @param {string} content - Message text
   */
  addMessage(sessionId, role, content) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.warn(`⚠️ [Memory] Session not found: ${sessionId}`);
      return;
    }

    session.messages.push({
      role,
      content,
      timestamp: Date.now(),
    });

    console.log(`📝 [Memory] [${sessionId}] ${role}: "${content.substring(0, 60)}..."`);
  }

  /**
   * Get conversation history for LLM (applies sliding window)
   * Returns messages formatted for the LLM API
   * @param {string} sessionId 
   * @returns {Array<{role: string, content: string}>}
   */
  getHistory(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return [];

    let messages = [];

    // If we have a summary from older messages, include it first
    if (session.summary) {
      messages.push({
        role: 'system',
        content: `Previous conversation summary: ${session.summary}`,
      });
    }

    // Apply sliding window — keep only the most recent messages
    const windowSize = config.memory.maxMessages;
    const recentMessages = session.messages.slice(-windowSize);

    // Format for LLM (strip timestamps)
    const formatted = recentMessages.map(m => ({
      role: m.role,
      content: m.content,
    }));

    messages.push(...formatted);
    return messages;
  }

  /**
   * Apply sliding window — remove oldest messages beyond the limit
   * @param {string} sessionId 
   */
  applyWindow(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const maxMessages = config.memory.maxMessages;
    if (session.messages.length > maxMessages) {
      const removed = session.messages.length - maxMessages;
      session.messages = session.messages.slice(-maxMessages);
      console.log(`📝 [Memory] Sliding window: removed ${removed} old messages`);
    }
  }

  /**
   * Summarize old messages and compact memory
   * Uses the LLM to create a summary, then removes old messages
   * @param {string} sessionId 
   * @param {Function} summarizeFn - LLM summarize function
   */
  async summarizeAndCompact(sessionId, summarizeFn) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const threshold = config.memory.summarizeAfter;
    if (session.messages.length <= threshold) return;

    // Take older messages to summarize (keep recent ones intact)
    const keepRecent = Math.floor(threshold / 2);
    const toSummarize = session.messages.slice(0, -keepRecent);
    const toKeep = session.messages.slice(-keepRecent);

    try {
      const summary = await summarizeFn(toSummarize);
      
      // Update session
      session.summary = session.summary
        ? `${session.summary}\n\nUpdate: ${summary}`
        : summary;
      session.messages = toKeep;

      console.log(`📝 [Memory] Summarized ${toSummarize.length} messages, keeping ${toKeep.length}`);
    } catch (error) {
      console.error('❌ [Memory] Summarization failed:', error.message);
      // Fall back to sliding window
      this.applyWindow(sessionId);
    }
  }

  /**
   * Get total message count for a session
   * @param {string} sessionId 
   * @returns {number}
   */
  getMessageCount(sessionId) {
    const session = this.sessions.get(sessionId);
    return session ? session.messages.length : 0;
  }

  /**
   * Clear a session's history
   * @param {string} sessionId 
   */
  clearSession(sessionId) {
    this.sessions.delete(sessionId);
    console.log(`🗑️ [Memory] Session cleared: ${sessionId}`);
  }

  /**
   * Get all active session IDs
   * @returns {Array<string>}
   */
  getActiveSessions() {
    return Array.from(this.sessions.keys());
  }
}

export default ConversationMemory;
