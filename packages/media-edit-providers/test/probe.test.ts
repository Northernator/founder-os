import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateOpencutVendor } from "../src/probe.js";

// Normalise a path candidate to forward slashes so the test stubs work
// identically on POSIX and Windows -- node:path.join emits backslashes
// on Windows, which trips `endsWith("apps/web/package.json")`. Matches
// the rule from feedback_test_paths_through_helpers.md.
function endsWithPosix(p: string, suffix: string): boolean {
  return p.split(path.sep).join("/").endsWith(suffix);
}

describe("validateOpencutVendor", () => {
  it("accepts a clone whose root package.json has 'opencut' in the name", async () => {
    const readFile = async (p: string) => {
      if (endsWithPosix(p, "apps/web/package.json")) throw new Error("ENOENT");
      if (endsWithPosix(p, "package.json")) {
        return JSON.stringify({ name: "opencut", version: "0.0.1" });
      }
      throw new Error("ENOENT");
    };
    const res = await validateOpencutVendor("/fake/vendor", { readFile });
    expect(res.valid).toBe(true);
    expect(res.packageName).toBe("opencut");
    expect(res.packageVersion).toBe("0.0.1");
  });

  it("accepts a monorepo clone whose apps/web package.json has 'opencut' in the name", async () => {
    const readFile = async (p: string) => {
      if (endsWithPosix(p, "apps/web/package.json")) {
        return JSON.stringify({ name: "opencut-web", version: "0.42.0" });
      }
      throw new Error("ENOENT");
    };
    const res = await validateOpencutVendor("/fake/vendor", { readFile });
    expect(res.valid).toBe(true);
    expect(res.packageName).toBe("opencut-web");
  });

  it("rejects a dir whose package.json does not mention opencut", async () => {
    const readFile = async () =>
      JSON.stringify({ name: "some-other-app", version: "1.0.0" });
    const res = await validateOpencutVendor("/fake/vendor", { readFile });
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/does not look like an OpenCut clone/);
  });

  it("rejects an empty dir (no readable package.json)", async () => {
    const readFile = async () => {
      throw new Error("ENOENT");
    };
    const res = await validateOpencutVendor("/fake/vendor", { readFile });
    expect(res.valid).toBe(false);
  });

  it("tolerates malformed JSON in package.json", async () => {
    const readFile = async () => "{ not valid json";
    const res = await validateOpencutVendor("/fake/vendor", { readFile });
    expect(res.valid).toBe(false);
  });
});
