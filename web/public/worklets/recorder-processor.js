/**
 * AudioWorklet PCM recorder.
 *
 * Forwards each render quantum's input channels to the main thread as Float32
 * copies. The main thread accumulates them into a recording buffer. Kept
 * intentionally minimal (no processing) so instrument input is captured raw.
 */
class RecorderProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0) {
      // Copy each channel (the underlying buffers are reused across quanta).
      const channels = input.map((ch) => {
        const copy = new Float32Array(ch.length);
        copy.set(ch);
        return copy;
      });
      this.port.postMessage({ channels });
    }
    return true; // keep alive until the node is disconnected
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
