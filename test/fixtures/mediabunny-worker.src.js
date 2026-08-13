// Decode through mediabunny's own abstractions, then leak frames exactly the
// way its API invites you to.
//
// mediabunny wraps WebCodecs, so nothing here constructs a VideoDecoder. If the
// census only saw decoders the application creates directly, everything below
// would be invisible — which is the case worth proving, since mediabunny's docs
// warn about precisely this footgun:
//
//   "The VideoFrame returned by this method *must* be closed separately from
//    this video sample."
//
// So a caller who diligently closes every VideoSample and forgets the frames
// leaks silently, and nothing in the platform tells them.

import {
  ALL_FORMATS,
  BufferSource,
  BufferTarget,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_LOW,
  VideoSample,
  VideoSampleSink,
  VideoSampleSource,
} from 'mediabunny';

const W = 64;
const H = 64;
const COUNT = 10;

function paint(i) {
  const data = new Uint8Array(W * H * 4);
  data.fill((i * 23) % 256);
  return new VideoFrame(data, {
    format: 'RGBA',
    codedWidth: W,
    codedHeight: H,
    timestamp: i * 33_333,
    duration: 33_333,
  });
}

/** Build a real MP4 in memory so the test needs no binary fixture. */
async function encode() {
  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const source = new VideoSampleSource({ codec: 'avc', bitrate: QUALITY_LOW });
  output.addVideoTrack(source);
  await output.start();

  for (let i = 0; i < COUNT; i++) {
    const frame = paint(i);
    const sample = new VideoSample(frame);
    await source.add(sample);
    sample.close(); // closes the frame it wraps
  }
  await output.finalize();
  return output.target.buffer;
}

async function decodeAndLeak(buffer) {
  const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(buffer) });
  const track = await input.getPrimaryVideoTrack();
  const sink = new VideoSampleSink(track);

  let samples = 0;
  let framesTaken = 0;
  let framesClosed = 0;

  for await (const sample of sink.samples()) {
    samples++;
    // The documented double-ownership rule: this frame is independent of the
    // sample and needs its own close().
    const frame = sample.toVideoFrame();
    framesTaken++;
    if (samples % 2 === 0) {
      frame.close();
      framesClosed++;
    }
    // The sample is always closed. Only the frames leak — the realistic mistake.
    sample.close();
  }

  return { samples, framesTaken, framesClosed, expectedLeak: framesTaken - framesClosed };
}

(async () => {
  try {
    const buffer = await encode();
    const result = await decodeAndLeak(buffer);
    self.postMessage({
      done: true,
      bytes: buffer.byteLength,
      ...result,
      instrumented: typeof globalThis.__webcodecsCensus === 'function',
    });
  } catch (error) {
    self.postMessage({ done: true, error: String(error?.stack ?? error) });
  }
})();
