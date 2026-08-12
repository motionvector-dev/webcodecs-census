// A worker that leaks the way real decode pipelines leak: the frames come from
// the decoder's output callback, never from a constructor, and some are dropped
// without close(). Line 1 allocates, so a late injector misses it.

const constructedAndLeaked = new VideoFrame(new Uint8Array(16), {
  format: 'RGBA', codedWidth: 2, codedHeight: 2, timestamp: 0,
});

const constructedAndClosed = new VideoFrame(new Uint8Array(16), {
  format: 'RGBA', codedWidth: 2, codedHeight: 2, timestamp: 1,
});
constructedAndClosed.close();

// A clone needs its own close(); this one never gets it.
const clonedAndLeaked = constructedAndLeaked.clone();

let decodedSeen = 0;
let decodedClosed = 0;

const decoder = new VideoDecoder({
  output(frame) {
    decodedSeen++;
    // Close only every other frame — the classic partial-close leak.
    if (decodedSeen % 2 === 0) {
      frame.close();
      decodedClosed++;
    }
  },
  error(e) {
    self.postMessage({ decoderError: String(e) });
  },
});

self.onmessage = async (e) => {
  if (e.data?.cmd === 'decode') {
    decoder.configure(e.data.config);
    for (const chunk of e.data.chunks) {
      decoder.decode(new EncodedVideoChunk(chunk));
    }
    await decoder.flush().catch(() => {});
    self.postMessage({ decodedSeen, decodedClosed });
    return;
  }
  if (e.data?.cmd === 'census') {
    self.postMessage({ census: globalThis.__webcodecsCensus?.local?.() ?? null });
  }
};

self.postMessage({
  ready: true,
  instrumented: typeof globalThis.__webcodecsCensus === 'function',
  // Proof the shim beat line 1: a late shim cannot have seen this object.
  sawLineOneAllocation:
    (globalThis.__webcodecsCensus?.local?.()?.live?.VideoFrame ?? 0) >= 1,
});
