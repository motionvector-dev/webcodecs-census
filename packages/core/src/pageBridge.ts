/**
 * The page world and an extension's content script cannot call each other, so
 * census requests cross the boundary as window messages. Only used by the
 * extension's patch mode; the CDP path evaluates in each context directly and
 * needs none of this.
 */

import { localCensus } from './census';
import { workerPatchState } from './workerPatch';

export function respondToCollectRequests(): void {
  if (typeof window === 'undefined') return;

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if ((event.data as any)?.__webcodecsCensus !== 'collect') return;

    const patch = workerPatchState();
    window.postMessage(
      {
        __webcodecsCensus: 'reply',
        id: (event.data as any).id,
        payload: {
          censuses: [localCensus()],
          // Patch mode is best-effort; say so rather than implying completeness.
          workersWrapped: patch?.wrapped ?? 0,
          workersSkipped: patch?.skipped ?? [],
          mode: 'patch',
        },
      },
      // Same-window delivery, so this does not cross an origin either way — but
      // naming the origin keeps the census out of any wider postMessage plumbing
      // a page happens to have. Note the API is a page global regardless: any
      // script in the document can call it directly.
      location.origin,
    );
  });
}
