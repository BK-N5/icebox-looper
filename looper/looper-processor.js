class LooperProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.loopLengthInSamples = null;
    this.currentSamplePosition = 0;

    this.isLoop1Recording = false;
    this.loop1Buffer = [];

    this.armedTrackIndex = null;
    this.isRecordingTrackIndex = null;
    this.currentRecording = null;

    this.port.onmessage = (event) => {
      const msg = event.data;

      if (msg.type === "startLoop1") {
        this.isLoop1Recording = true;
        this.loop1Buffer = [];
        this.loopLengthInSamples = null;
        this.currentSamplePosition = 0;
      }

      if (msg.type === "stopLoop1") {
        this.isLoop1Recording = false;

        const length = this.loop1Buffer.length;
        if (length > 0) {
          this.loopLengthInSamples = length;
          const buf = new Float32Array(length);
          for (let i = 0; i < length; i++) {
            buf[i] = this.loop1Buffer[i];
          }

          this.port.postMessage(
            {
              type: "loop1Recorded",
              loopLengthInSamples: this.loopLengthInSamples,
              buffer: buf
            },
            [buf.buffer]
          );

          this.currentSamplePosition = 0;
        }
      }

      if (msg.type === "armLoop2") {
        if (
          this.loopLengthInSamples !== null &&
          this.armedTrackIndex === null &&
          this.isRecordingTrackIndex === null
        ) {
          this.armedTrackIndex = msg.trackIndex;
        }
      }
    };
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const channel = input[0];
    if (!channel) return true;

    const blockSize = channel.length;

    for (let i = 0; i < blockSize; i++) {
      const sample = channel[i];

      // Loop 1: free recording to define loop length
      if (this.isLoop1Recording) {
        this.loop1Buffer.push(sample);
      }

      // Once loop length is known, we have a grid
      if (this.loopLengthInSamples !== null) {
        this.currentSamplePosition =
          (this.currentSamplePosition + 1) % this.loopLengthInSamples;

        // Start recording a secondary track exactly at sample 0
        if (
          this.armedTrackIndex !== null &&
          this.currentSamplePosition === 0
        ) {
          this.isRecordingTrackIndex = this.armedTrackIndex;
          this.armedTrackIndex = null;
          this.currentRecording = [];
          this.port.postMessage({
            type: "loop2Started",
            trackIndex: this.isRecordingTrackIndex
          });
        }

        // Capture samples for the armed track
        if (this.isRecordingTrackIndex !== null && this.currentRecording) {
          this.currentRecording.push(sample);
        }

        // Stop recording exactly at end of loop
        if (
          this.isRecordingTrackIndex !== null &&
          this.currentRecording &&
          this.currentSamplePosition === this.loopLengthInSamples - 1
        ) {
          const length = this.currentRecording.length;
          const buf = new Float32Array(length);
          for (let i = 0; i < length; i++) {
            buf[i] = this.currentRecording[i];
          }

          this.port.postMessage(
            {
              type: "loopRecorded",
              trackIndex: this.isRecordingTrackIndex,
              buffer: buf
            },
            [buf.buffer]
          );

          this.isRecordingTrackIndex = null;
          this.currentRecording = null;
        }
      }
    }

    return true;
  }
}

registerProcessor("looper-processor", LooperProcessor);
