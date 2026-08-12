// Encode a handful of frames, then decode them and close only half. The frames
// that leak here are exactly the kind that leak in a real pipeline: produced by
// the decoder, never constructed, and dropped without close().

const W = 64;
const H = 64;
const COUNT = 10;

function makeFrame(i) {
  const data = new Uint8Array(W * H * 4);
  data.fill(i * 20);
  return new VideoFrame(data, {
    format: 'RGBA', codedWidth: W, codedHeight: H, timestamp: i * 33_333,
  });
}

const chunks = [];

const encoder = new VideoEncoder({
  output: (chunk) => chunks.push(chunk),
  error: (e) => self.postMessage({ stage: 'encode', error: String(e) }),
});
encoder.configure({ codec: 'vp8', width: W, height: H, bitrate: 200_000 });

for (let i = 0; i < COUNT; i++) {
  const f = makeFrame(i);
  encoder.encode(f, { keyFrame: i === 0 });
  f.close(); // the source frames are handled correctly on purpose
}
await encoder.flush();
encoder.close();

let decodedSeen = 0;
let decodedClosed = 0;

const decoder = new VideoDecoder({
  output: (frame) => {
    decodedSeen++;
    if (decodedSeen % 2 === 0) {
      frame.close();
      decodedClosed++;
    }
    // odd-numbered frames are deliberately leaked
  },
  error: (e) => self.postMessage({ stage: 'decode', error: String(e) }),
});
decoder.configure({ codec: 'vp8', codedWidth: W, codedHeight: H });

for (const chunk of chunks) decoder.decode(chunk);
await decoder.flush();

self.postMessage({
  done: true,
  encoded: chunks.length,
  decodedSeen,
  decodedClosed,
  expectedLeak: decodedSeen - decodedClosed,
});
