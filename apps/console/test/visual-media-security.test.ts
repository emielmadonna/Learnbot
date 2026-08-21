import assert from "node:assert/strict";
import test from "node:test";

import {
  VisualMediaValidationError,
  verifyVisualMedia,
} from "../src/lib/visuals/secure-media";
import {
  buildAccessibleBarChart,
  ChartDataError,
  parseChartTable,
} from "../src/lib/visuals/chart";

const encoder = new TextEncoder();

function box(type: string, payload: Uint8Array) {
  const bytes = new Uint8Array(8 + payload.length);
  new DataView(bytes.buffer).setUint32(0, bytes.length);
  bytes.set(encoder.encode(type), 4);
  bytes.set(payload, 8);
  return bytes;
}

function concat(...parts: Uint8Array[]) {
  const result = new Uint8Array(
    parts.reduce((length, part) => length + part.length, 0),
  );
  let cursor = 0;
  for (const part of parts) {
    result.set(part, cursor);
    cursor += part.length;
  }
  return result;
}

function validMp4() {
  const ftypPayload = new Uint8Array(16);
  ftypPayload.set(encoder.encode("isom"), 0);
  ftypPayload.set(encoder.encode("isom"), 8);
  ftypPayload.set(encoder.encode("mp42"), 12);
  const handler = new Uint8Array(12);
  handler.set(encoder.encode("vide"), 8);
  const sampleEntryPayload = new Uint8Array(36);
  new DataView(sampleEntryPayload.buffer).setUint16(24, 640);
  new DataView(sampleEntryPayload.buffer).setUint16(26, 360);
  const sampleEntry = box("avc1", sampleEntryPayload);
  const sampleDescription = new Uint8Array(8 + sampleEntry.length);
  new DataView(sampleDescription.buffer).setUint32(4, 1);
  sampleDescription.set(sampleEntry, 8);
  const movie = box(
    "trak",
    box(
      "mdia",
      concat(
        box("hdlr", handler),
        box("minf", box("stbl", box("stsd", sampleDescription))),
      ),
    ),
  );
  return concat(
    box("ftyp", ftypPayload),
    box("moov", movie),
    box("mdat", new Uint8Array([0, 0, 0, 1, 9, 16])),
  );
}

function expectCode(code: VisualMediaValidationError["code"]) {
  return (error: unknown) =>
    error instanceof VisualMediaValidationError && error.code === code;
}

test("secure visual validation accepts generated SVG and structurally valid MP4", async () => {
  const chart = buildAccessibleBarChart(
    "Month,Lessons\nJanuary,12\nFebruary,18",
    "Lessons completed",
  );
  const svg = encoder.encode(chart.svg);
  const svgResult = await verifyVisualMedia(svg, "image/svg+xml");
  assert.equal(svgResult.sizeBytes, svg.length);
  assert.match(svgResult.sha256, /^[0-9a-f]{64}$/u);

  const mp4 = validMp4();
  const mp4Result = await verifyVisualMedia(mp4, "video/mp4");
  assert.equal(mp4Result.sizeBytes, mp4.length);
});

test("SVG validation rejects active, foreign, encoded and over-budget content", async () => {
  const unsafe = [
    '<svg viewBox="0 0 10 10"><script>1</script></svg>',
    '<svg viewBox="0 0 10 10"><foreignObject/></svg>',
    '<svg viewBox="0 0 10 10"><rect fill="&#x75;rl(#paint)"/></svg>',
    '<svg viewBox="0 0 10 10"><image href="https://example.test/a.png"/></svg>',
    '<svg viewBox="0 0 100000 10"><rect width="1" height="1"/></svg>',
  ];
  for (const source of unsafe) {
    await assert.rejects(
      verifyVisualMedia(encoder.encode(source), "image/svg+xml"),
      expectCode("unsafe_svg"),
    );
  }
});

test("MP4 validation rejects a branded arbitrary payload without movie and media boxes", async () => {
  const ftypPayload = new Uint8Array(16);
  ftypPayload.set(encoder.encode("isom"), 0);
  ftypPayload.set(encoder.encode("isom"), 8);
  ftypPayload.set(encoder.encode("mp42"), 12);
  const polyglot = concat(
    box("ftyp", ftypPayload),
    box("free", encoder.encode("<script>alert(1)</script>")),
  );
  await assert.rejects(
    verifyVisualMedia(polyglot, "video/mp4"),
    expectCode("media_signature_invalid"),
  );
});

test("chart parsing is bounded and never silently coerces ambiguous cells", () => {
  assert.throws(
    () => parseChartTable("Month,Total\nJanuary,"),
    ChartDataError,
  );
  assert.throws(
    () => parseChartTable("Month,Total,total\nJanuary,1,2"),
    ChartDataError,
  );
  assert.throws(
    () => parseChartTable("Month,Total\nJanuary,=2+2"),
    ChartDataError,
  );
  assert.throws(
    () => parseChartTable("Month,Total\nJanuary,$10\nFebruary,20%"),
    ChartDataError,
  );
  assert.throws(
    () =>
      parseChartTable(
        [
          "Month,Total",
          ...Array.from({ length: 25 }, (_, index) => `M${index + 1},${index + 1}`),
        ].join("\n"),
      ),
    ChartDataError,
  );
  assert.equal(
    parseChartTable("\uFEFFMonth,Total\nJanuary,10").headers[0],
    "Month",
  );
});

test("chart generation escapes user labels and includes accessible SVG metadata", () => {
  const chart = buildAccessibleBarChart(
    'Team,Score\n"Research & <Ops>",42',
    "Quarter <one>",
  );
  assert.match(chart.svg, /<title>Quarter &lt;one&gt;<\/title>/u);
  assert.match(chart.svg, /<desc>/u);
  assert.match(chart.svg, /role="img"/u);
  assert.doesNotMatch(chart.svg, /<script|<foreignObject|style=/iu);
  assert.match(chart.altText, /Research & <Ops>/u);
});
