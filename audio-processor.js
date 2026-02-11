/**
 * Audio Processor Worklet
 * 
 * Runs on a dedicated audio thread for smooth, glitch-free audio processing.
 * Converts incoming audio samples to Int16 (linear16) format and sends
 * to the main thread via MessagePort.
 * 
 * This is the modern replacement for the deprecated ScriptProcessorNode.
 */
class MicrophoneProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    
    // Buffer to collect samples before sending (reduces message overhead)
    this.buffer = [];
    this.bufferSize = 4096;  // Send when buffer reaches this size
    
    // Handle start/stop messages from main thread
    this.port.onmessage = (event) => {
      if (event.data.type === 'stop') {
        // Flush any remaining buffer
        if (this.buffer.length > 0) {
          this.sendBuffer();
        }
      }
    };
  }

  /**
   * Convert Float32 samples to Int16 and send to main thread
   */
  sendBuffer() {
    const int16 = new Int16Array(this.buffer.length);
    for (let i = 0; i < this.buffer.length; i++) {
      const s = Math.max(-1, Math.min(1, this.buffer[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    
    // Transfer the underlying ArrayBuffer for efficiency
    this.port.postMessage({ type: 'audio', buffer: int16.buffer }, [int16.buffer]);
    this.buffer = [];
  }

  /**
   * Process audio samples (called automatically by the audio system)
   * @param {Float32Array[][]} inputs - Input audio channels
   * @param {Float32Array[][]} outputs - Output audio channels (unused)
   * @returns {boolean} - Return true to keep processor alive
   */
  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0) {
      const channelData = input[0];  // Mono channel
      
      // Add samples to buffer
      for (let i = 0; i < channelData.length; i++) {
        this.buffer.push(channelData[i]);
      }
      
      // Send when buffer is full
      if (this.buffer.length >= this.bufferSize) {
        this.sendBuffer();
      }
    }
    
    return true;  // Keep processing
  }
}

// Register the processor
registerProcessor('microphone-processor', MicrophoneProcessor);
