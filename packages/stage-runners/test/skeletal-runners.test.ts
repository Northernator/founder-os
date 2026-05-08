/**
 * skeletal-runners.test.ts -- placeholder for future skeletal runners.
 *
 * History:
 *   - 2026-05-03: original skeletal Validation/Wireframe/Finance/Launch
 *     runners had their tests here.
 *   - 2026-05-05: those 4 runners were promoted to real pipeline-runner-
 *     backed steps; their dedicated tests moved to *-runner-real.test.ts
 *     and this file became an it.todo placeholder.
 *   - 2026-05-07: MediaStageRunner shipped here as a skeletal placeholder
 *     (slice 3 of media arc) -- 4 real tests landed.
 *   - 2026-05-07 (later): MediaStageRunner promoted to real (slice 4).
 *     Tests moved to media-runner-real.test.ts. File reverts to
 *     it.todo placeholder, mirroring the same lifecycle as the prior 4.
 *
 * Pattern: when a future stage runner ships as a placeholder before
 * its underlying step lands, its tests go here. On promotion, they
 * move to *-runner-real.test.ts and this file goes back to a single
 * it.todo so vitest 1.6.x doesn't reject the empty file.
 */
import { describe, it } from "vitest";

describe("skeletal-runners (placeholder)", () => {
  it.todo("re-add skeletal-runner tests if a new placeholder runner ships");
});
