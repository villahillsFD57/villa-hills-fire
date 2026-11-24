import assert from "node:assert/strict";
import test from "node:test";
import { parseDispatchEmail } from "../lib/cad/parser.ts";

const body = "[57 Fire CAD] WIRES DOWN -- TEST LOCATION -- Box: TEST -- Units: VLHL 5711";

test("folded email and forwarded subject retain the dispatch type", () => {
  const result = parseDispatchEmail(" Fwd: RE: chief   alert ",
    "[57 Fire CAD]\nWIRES\r\nDOWN -- TEST\nLOCATION -- Box: TEST -- Units: VLHL 5711",
    new Date("2026-11-24T02:30:00Z"));
  assert.equal(result.status, "ok");
  assert.equal(result.dispatchNature, "WIRES DOWN");
  assert.equal(result.dispatchDate, "11/23/2026");
  assert.equal(result.dispatchTime, "20:30");
});

test("Chicago year rollover follows the event timestamp, not server year", () => {
  const before = parseDispatchEmail("Chief Alert", body, new Date("2027-01-01T05:59:00Z"));
  const after = parseDispatchEmail("Chief Alert", body, new Date("2027-01-01T06:00:00Z"));
  assert.equal(before.sourceYear, 2026);
  assert.equal(before.dispatchDate, "12/31/2026");
  assert.equal(after.sourceYear, 2027);
  assert.equal(after.dispatchDate, "01/01/2027");
  assert.equal(after.dispatchTime, "00:00");
});

test("summer and winter timestamps use the correct Chicago offset", () => {
  assert.equal(parseDispatchEmail("Chief Alert", body, new Date("2026-07-10T12:00:00Z")).dispatchTime, "07:00");
  assert.equal(parseDispatchEmail("Chief Alert", body, new Date("2026-11-10T12:00:00Z")).dispatchTime, "06:00");
});

test("unrelated subjects, missing CAD fields, and other agencies remain rejected", () => {
  const received = new Date("2026-11-24T02:30:00Z");
  assert.equal(parseDispatchEmail("Chief Alert Newsletter", body, received).status, "failed");
  assert.equal(parseDispatchEmail("Chief Alert", "WIRES DOWN -- Units: VLHL", received).status, "failed");
  assert.equal(parseDispatchEmail("Chief Alert", body.replace("VLHL 5711", "OTHER 100"), received).status, "failed");
  assert.equal(parseDispatchEmail("Chief Alert", body.replace("VLHL 5711", "NOTVLHL 100"), received).status, "failed");
});

test("invalid date is rejected without throwing or fabricating the current time", () => {
  assert.deepEqual(parseDispatchEmail("Chief Alert", body, new Date("invalid")), {
    status: "failed", reason: "Invalid received timestamp",
  });
});

test("categories rejected by storage are intentional parse rejections, not endless retries", () => {
  const received = new Date("2026-11-24T02:30:00Z");
  for (const category of ["x".repeat(161), "<SCRIPT>", "PERSON@EXAMPLE.TEST", "NATURE\u0000BAD"]) {
    assert.deepEqual(parseDispatchEmail("Chief Alert", body.replace("WIRES DOWN", category), received), {
      status: "failed", reason: "Invalid dispatch nature",
    });
  }
  assert.equal(parseDispatchEmail("Chief Alert", body.replace("WIRES DOWN", "x".repeat(160)), received).status, "ok");
});
