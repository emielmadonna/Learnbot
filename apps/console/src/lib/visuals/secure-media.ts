const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const SVG_TAGS = new Set([
  "circle",
  "desc",
  "ellipse",
  "g",
  "line",
  "path",
  "polygon",
  "polyline",
  "rect",
  "svg",
  "text",
  "title",
  "tspan",
]);
const SVG_ATTRIBUTES = new Set([
  "aria-label",
  "aria-labelledby",
  "cx",
  "cy",
  "d",
  "dominant-baseline",
  "fill",
  "fill-opacity",
  "font-family",
  "font-size",
  "font-weight",
  "height",
  "id",
  "letter-spacing",
  "opacity",
  "points",
  "preserveaspectratio",
  "r",
  "role",
  "rx",
  "ry",
  "stroke",
  "stroke-dasharray",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-opacity",
  "stroke-width",
  "text-anchor",
  "transform",
  "viewbox",
  "width",
  "x",
  "x1",
  "x2",
  "xmlns",
  "y",
  "y1",
  "y2",
]);
const SAFE_MP4_BRANDS = new Set([
  "3g2a",
  "3g2b",
  "3gp4",
  "3gp5",
  "3gp6",
  "avc1",
  "dash",
  "iso2",
  "iso3",
  "iso4",
  "iso5",
  "iso6",
  "isom",
  "m4v ",
  "mp41",
  "mp42",
  "msdh",
  "msix",
  "qt  ",
]);
const SAFE_MP4_TOP_LEVEL_BOXES = new Set([
  "free",
  "ftyp",
  "mdat",
  "meta",
  "mfra",
  "moof",
  "moov",
  "pdin",
  "skip",
  "sidx",
  "styp",
  "uuid",
  "wide",
]);
const SAFE_VIDEO_SAMPLE_ENTRIES = [
  "av01",
  "avc1",
  "avc3",
  "hev1",
  "hvc1",
  "mp4v",
  "vp09",
];
const MP4_MOOV_CHILDREN = new Set([
  "cmov",
  "free",
  "iods",
  "meta",
  "mvex",
  "mvhd",
  "pssh",
  "skip",
  "trak",
  "udta",
  "uuid",
]);
const MP4_TRAK_CHILDREN = new Set([
  "clip",
  "edts",
  "free",
  "imap",
  "load",
  "matt",
  "mdia",
  "meta",
  "skip",
  "tapt",
  "tref",
  "tkhd",
  "udta",
  "uuid",
]);
const MP4_MDIA_CHILDREN = new Set(["elng", "hdlr", "mdhd", "minf", "uuid"]);
const MP4_MINF_CHILDREN = new Set([
  "dinf",
  "free",
  "gmhd",
  "hdlr",
  "hmhd",
  "nmhd",
  "smhd",
  "stbl",
  "vmhd",
]);
const MP4_STBL_CHILDREN = new Set([
  "co64",
  "cslg",
  "ctts",
  "free",
  "padb",
  "sbgp",
  "sdtp",
  "sgpd",
  "stco",
  "stdp",
  "stps",
  "stsc",
  "stsd",
  "stsh",
  "stss",
  "stsz",
  "stts",
  "stz2",
  "subs",
  "uuid",
]);
const MAX_SVG_NODES = 2_000;
const MAX_SVG_DEPTH = 32;
const MAX_SVG_ATTRIBUTES_PER_NODE = 32;
const MAX_SVG_VIEWBOX_EDGE = 10_000;
const MAX_SVG_VIEWBOX_AREA = 25_000_000;
const MAX_RASTER_EDGE = 10_000;
const MAX_RASTER_PIXELS = 40_000_000;
const SAFE_PNG_CHUNKS = new Set([
  "chrm",
  "gama",
  "idat",
  "iend",
  "ihdr",
  "phys",
  "plte",
  "srgb",
  "trns",
]);
const SAFE_WEBP_CHUNKS = new Set([
  "alph",
  "exif",
  "iccp",
  "vp8 ",
  "vp8l",
  "vp8x",
  "xmp ",
]);
const CRC_TABLE = Array.from({ length: 256 }, (_, seed) => {
  let value = seed;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

export const MAX_VISUAL_BYTES = 20_971_520;

export const VISUAL_MEDIA_EXTENSIONS = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/svg+xml", "svg"],
  ["video/mp4", "mp4"],
]);

export type VisualMediaType =
  | "image/jpeg"
  | "image/png"
  | "image/svg+xml"
  | "image/webp"
  | "video/mp4";

export class VisualMediaValidationError extends Error {
  readonly code:
    | "media_signature_invalid"
    | "media_type_unsupported"
    | "media_size_invalid"
    | "unsafe_svg";

  constructor(code: VisualMediaValidationError["code"]) {
    super(code);
    this.name = "VisualMediaValidationError";
    this.code = code;
  }
}

function bytesMatch(bytes: Uint8Array, offset: number, expected: number[]) {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function ascii(bytes: Uint8Array, start: number, end: number) {
  return String.fromCharCode(...bytes.subarray(start, end)).toLowerCase();
}

function uint32(bytes: Uint8Array, offset: number, littleEndian = false) {
  if (offset + 4 > bytes.length) return null;
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset + offset,
    4,
  );
  return view.getUint32(0, littleEndian);
}

function uint24(bytes: Uint8Array, offset: number, littleEndian = false) {
  if (offset + 3 > bytes.length) return null;
  return littleEndian
    ? bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)
    : (bytes[offset]! << 16) | (bytes[offset + 1]! << 8) | bytes[offset + 2]!;
}

function uint16(bytes: Uint8Array, offset: number, littleEndian = false) {
  if (offset + 2 > bytes.length) return null;
  return littleEndian
    ? bytes[offset]! | (bytes[offset + 1]! << 8)
    : (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function assertDimensions(width: number | null, height: number | null) {
  if (
    width === null ||
    height === null ||
    width < 1 ||
    height < 1 ||
    width > MAX_RASTER_EDGE ||
    height > MAX_RASTER_EDGE ||
    width * height > MAX_RASTER_PIXELS
  ) {
    throw new VisualMediaValidationError("media_signature_invalid");
  }
}

function crc32(bytes: Uint8Array, start: number, end: number) {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc = CRC_TABLE[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function uint64(bytes: Uint8Array, offset: number) {
  if (offset + 8 > bytes.length) return null;
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset + offset,
    8,
  );
  const value = view.getBigUint64(0);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

function assertPng(bytes: Uint8Array) {
  if (
    bytes.length < 33 ||
    !bytesMatch(bytes, 0, PNG_SIGNATURE)
  ) {
    throw new VisualMediaValidationError("media_signature_invalid");
  }
  let cursor = 8;
  let chunkCount = 0;
  let hasHeader = false;
  let hasImageData = false;
  let hasEnd = false;
  while (cursor < bytes.length) {
    const length = uint32(bytes, cursor);
    if (
      length === null ||
      cursor + 12 + length > bytes.length ||
      chunkCount >= 1_000
    ) {
      throw new VisualMediaValidationError("media_signature_invalid");
    }
    const type = ascii(bytes, cursor + 4, cursor + 8);
    const dataStart = cursor + 8;
    const dataEnd = dataStart + length;
    const expectedCrc = uint32(bytes, dataEnd);
    if (
      !SAFE_PNG_CHUNKS.has(type) ||
      expectedCrc === null ||
      crc32(bytes, cursor + 4, dataEnd) !== expectedCrc
    ) {
      throw new VisualMediaValidationError("media_signature_invalid");
    }
    if (chunkCount === 0) {
      if (type !== "ihdr" || length !== 13) {
        throw new VisualMediaValidationError("media_signature_invalid");
      }
      assertDimensions(uint32(bytes, dataStart), uint32(bytes, dataStart + 4));
      hasHeader = true;
    } else if (type === "ihdr") {
      throw new VisualMediaValidationError("media_signature_invalid");
    }
    if (type === "idat" && length > 0) hasImageData = true;
    if (type === "iend") {
      if (length !== 0 || dataEnd + 4 !== bytes.length) {
        throw new VisualMediaValidationError("media_signature_invalid");
      }
      hasEnd = true;
    }
    cursor = dataEnd + 4;
    chunkCount += 1;
  }
  if (!hasHeader || !hasImageData || !hasEnd) {
    throw new VisualMediaValidationError("media_signature_invalid");
  }
}

function assertJpeg(bytes: Uint8Array) {
  if (
    bytes.length < 12 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes[2] !== 0xff ||
    bytes.at(-2) !== 0xff ||
    bytes.at(-1) !== 0xd9
  ) {
    throw new VisualMediaValidationError("media_signature_invalid");
  }
  let cursor = 2;
  let hasFrame = false;
  let hasScan = false;
  while (cursor < bytes.length - 2 && !hasScan) {
    if (bytes[cursor] !== 0xff) {
      throw new VisualMediaValidationError("media_signature_invalid");
    }
    while (bytes[cursor] === 0xff) cursor += 1;
    const marker = bytes[cursor]!;
    cursor += 1;
    if (marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const segmentLength = uint16(bytes, cursor);
    if (
      segmentLength === null ||
      segmentLength < 2 ||
      cursor + segmentLength > bytes.length
    ) {
      throw new VisualMediaValidationError("media_signature_invalid");
    }
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      if (segmentLength < 8) {
        throw new VisualMediaValidationError("media_signature_invalid");
      }
      assertDimensions(
        uint16(bytes, cursor + 5),
        uint16(bytes, cursor + 3),
      );
      hasFrame = true;
    }
    if (marker === 0xda) hasScan = true;
    cursor += segmentLength;
  }
  if (!hasFrame || !hasScan) {
    throw new VisualMediaValidationError("media_signature_invalid");
  }
}

function assertWebp(bytes: Uint8Array) {
  const declaredSize = uint32(bytes, 4, true);
  if (
    bytes.length < 20 ||
    ascii(bytes, 0, 4) !== "riff" ||
    ascii(bytes, 8, 12) !== "webp" ||
    declaredSize !== bytes.length - 8
  ) {
    throw new VisualMediaValidationError("media_signature_invalid");
  }
  let cursor = 12;
  let imagePayloads = 0;
  let dimensions: { width: number; height: number } | null = null;
  while (cursor < bytes.length) {
    if (cursor + 8 > bytes.length) {
      throw new VisualMediaValidationError("media_signature_invalid");
    }
    const type = ascii(bytes, cursor, cursor + 4);
    const length = uint32(bytes, cursor + 4, true);
    if (
      length === null ||
      !SAFE_WEBP_CHUNKS.has(type) ||
      cursor + 8 + length + (length % 2) > bytes.length
    ) {
      throw new VisualMediaValidationError("media_signature_invalid");
    }
    const dataStart = cursor + 8;
    if (type === "vp8 ") {
      if (
        length < 10 ||
        !bytesMatch(bytes, dataStart + 3, [0x9d, 0x01, 0x2a])
      ) {
        throw new VisualMediaValidationError("media_signature_invalid");
      }
      dimensions = {
        width: uint16(bytes, dataStart + 6, true)! & 0x3fff,
        height: uint16(bytes, dataStart + 8, true)! & 0x3fff,
      };
      imagePayloads += 1;
    } else if (type === "vp8l") {
      if (length < 5 || bytes[dataStart] !== 0x2f) {
        throw new VisualMediaValidationError("media_signature_invalid");
      }
      const packed = uint32(bytes, dataStart + 1, true)!;
      dimensions = {
        width: (packed & 0x3fff) + 1,
        height: ((packed >>> 14) & 0x3fff) + 1,
      };
      imagePayloads += 1;
    } else if (type === "vp8x") {
      if (length !== 10) {
        throw new VisualMediaValidationError("media_signature_invalid");
      }
      dimensions = {
        width: uint24(bytes, dataStart + 4, true)! + 1,
        height: uint24(bytes, dataStart + 7, true)! + 1,
      };
    }
    cursor += 8 + length + (length % 2);
  }
  if (imagePayloads !== 1 || dimensions === null) {
    throw new VisualMediaValidationError("media_signature_invalid");
  }
  assertDimensions(dimensions.width, dimensions.height);
}

type Mp4Box = {
  dataStart: number;
  end: number;
  type: string;
};

function mp4Boxes(
  bytes: Uint8Array,
  start: number,
  end: number,
  allowed: ReadonlySet<string>,
) {
  const boxes: Mp4Box[] = [];
  let cursor = start;
  while (cursor < end) {
    const shortSize = uint32(bytes, cursor);
    const type = ascii(bytes, cursor + 4, cursor + 8);
    if (
      cursor + 8 > end ||
      shortSize === null ||
      !allowed.has(type) ||
      boxes.length >= 256
    ) {
      throw new VisualMediaValidationError("media_signature_invalid");
    }
    let headerSize = 8;
    let size = shortSize;
    if (shortSize === 1) {
      const extended = uint64(bytes, cursor + 8);
      if (extended === null) {
        throw new VisualMediaValidationError("media_signature_invalid");
      }
      headerSize = 16;
      size = extended;
    } else if (shortSize === 0) {
      size = end - cursor;
    }
    if (size < headerSize || cursor + size > end) {
      throw new VisualMediaValidationError("media_signature_invalid");
    }
    boxes.push({
      dataStart: cursor + headerSize,
      end: cursor + size,
      type,
    });
    cursor += size;
  }
  if (cursor !== end) {
    throw new VisualMediaValidationError("media_signature_invalid");
  }
  return boxes;
}

function hasValidVideoSampleDescription(
  bytes: Uint8Array,
  stsd: Mp4Box,
) {
  if (stsd.dataStart + 8 > stsd.end) return false;
  const entryCount = uint32(bytes, stsd.dataStart + 4);
  if (entryCount === null || entryCount < 1 || entryCount > 64) return false;
  let cursor = stsd.dataStart + 8;
  for (let index = 0; index < entryCount; index += 1) {
    const size = uint32(bytes, cursor);
    const type = ascii(bytes, cursor + 4, cursor + 8);
    if (
      size === null ||
      size < 36 ||
      cursor + size > stsd.end
    ) {
      return false;
    }
    if (SAFE_VIDEO_SAMPLE_ENTRIES.includes(type)) {
      const width = uint16(bytes, cursor + 8 + 24);
      const height = uint16(bytes, cursor + 8 + 26);
      try {
        assertDimensions(width, height);
      } catch {
        return false;
      }
      return true;
    }
    cursor += size;
  }
  return false;
}

function hasValidVideoTrack(
  bytes: Uint8Array,
  movieStart: number,
  movieEnd: number,
) {
  const movieChildren = mp4Boxes(
    bytes,
    movieStart,
    movieEnd,
    MP4_MOOV_CHILDREN,
  );
  for (const track of movieChildren.filter((box) => box.type === "trak")) {
    const trackChildren = mp4Boxes(
      bytes,
      track.dataStart,
      track.end,
      MP4_TRAK_CHILDREN,
    );
    for (const media of trackChildren.filter((box) => box.type === "mdia")) {
      const mediaChildren = mp4Boxes(
        bytes,
        media.dataStart,
        media.end,
        MP4_MDIA_CHILDREN,
      );
      const handler = mediaChildren.find((box) => box.type === "hdlr");
      const isVideo =
        handler !== undefined &&
        handler.dataStart + 12 <= handler.end &&
        ascii(bytes, handler.dataStart + 8, handler.dataStart + 12) === "vide";
      if (!isVideo) continue;
      for (const mediaInfo of mediaChildren.filter(
        (box) => box.type === "minf",
      )) {
        const mediaInfoChildren = mp4Boxes(
          bytes,
          mediaInfo.dataStart,
          mediaInfo.end,
          MP4_MINF_CHILDREN,
        );
        for (const sampleTable of mediaInfoChildren.filter(
          (box) => box.type === "stbl",
        )) {
          const tableChildren = mp4Boxes(
            bytes,
            sampleTable.dataStart,
            sampleTable.end,
            MP4_STBL_CHILDREN,
          );
          if (
            tableChildren
              .filter((box) => box.type === "stsd")
              .some((box) => hasValidVideoSampleDescription(bytes, box))
          ) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

function assertMp4(bytes: Uint8Array) {
  const firstBoxSize = uint32(bytes, 0);
  if (
    bytes.length < 24 ||
    firstBoxSize === null ||
    firstBoxSize < 16 ||
    firstBoxSize > Math.min(bytes.length, 4096) ||
    ascii(bytes, 4, 8) !== "ftyp"
  ) {
    throw new VisualMediaValidationError("media_signature_invalid");
  }
  const brands: string[] = [ascii(bytes, 8, 12)];
  for (let offset = 16; offset + 4 <= firstBoxSize; offset += 4) {
    brands.push(ascii(bytes, offset, offset + 4));
  }
  if (!brands.some((brand) => SAFE_MP4_BRANDS.has(brand))) {
    throw new VisualMediaValidationError("media_signature_invalid");
  }

  let cursor = 0;
  let boxCount = 0;
  let hasMediaData = false;
  let movieStart = -1;
  let movieEnd = -1;
  while (cursor < bytes.length) {
    if (cursor + 8 > bytes.length || boxCount >= 256) {
      throw new VisualMediaValidationError("media_signature_invalid");
    }
    const shortSize = uint32(bytes, cursor);
    const type = ascii(bytes, cursor + 4, cursor + 8);
    if (
      shortSize === null ||
      !/^[a-z0-9 ]{4}$/u.test(type) ||
      !SAFE_MP4_TOP_LEVEL_BOXES.has(type)
    ) {
      throw new VisualMediaValidationError("media_signature_invalid");
    }
    let headerSize = 8;
    let boxSize = shortSize;
    if (shortSize === 1) {
      const extended = uint64(bytes, cursor + 8);
      if (extended === null) {
        throw new VisualMediaValidationError("media_signature_invalid");
      }
      headerSize = 16;
      boxSize = extended;
    } else if (shortSize === 0) {
      boxSize = bytes.length - cursor;
    }
    if (
      boxSize < headerSize ||
      cursor + boxSize > bytes.length ||
      (shortSize === 0 && cursor + boxSize !== bytes.length)
    ) {
      throw new VisualMediaValidationError("media_signature_invalid");
    }
    if (type === "mdat" && boxSize > headerSize) hasMediaData = true;
    if (type === "moov") {
      movieStart = cursor + headerSize;
      movieEnd = cursor + boxSize;
    }
    cursor += boxSize;
    boxCount += 1;
  }
  if (!hasMediaData || movieStart < 0 || movieEnd <= movieStart) {
    throw new VisualMediaValidationError("media_signature_invalid");
  }
  if (!hasValidVideoTrack(bytes, movieStart, movieEnd)) {
    throw new VisualMediaValidationError("media_signature_invalid");
  }
}

function decodeXmlAttribute(value: string) {
  return value.replace(
    /&(?:#x([0-9a-f]+)|#([0-9]+)|(amp|apos|gt|lt|quot));/giu,
    (entity, hex: string | undefined, decimal: string | undefined, named: string | undefined) => {
      if (hex !== undefined || decimal !== undefined) {
        const codePoint = Number.parseInt(hex ?? decimal!, hex ? 16 : 10);
        if (
          !Number.isSafeInteger(codePoint) ||
          codePoint < 0 ||
          codePoint > 0x10ffff ||
          (codePoint >= 0xd800 && codePoint <= 0xdfff)
        ) {
          throw new VisualMediaValidationError("unsafe_svg");
        }
        return String.fromCodePoint(codePoint);
      }
      const values: Record<string, string> = {
        amp: "&",
        apos: "'",
        gt: ">",
        lt: "<",
        quot: '"',
      };
      return values[named!.toLowerCase()]!;
    },
  );
}

function assertSafeAttribute(name: string, rawValue: string, root: boolean) {
  const normalizedName = name.toLowerCase();
  if (/&(?!#x[0-9a-f]+;|#[0-9]+;|amp;|apos;|gt;|lt;|quot;)/iu.test(rawValue)) {
    throw new VisualMediaValidationError("unsafe_svg");
  }
  const value = decodeXmlAttribute(rawValue);
  if (
    !SVG_ATTRIBUTES.has(normalizedName) ||
    normalizedName.startsWith("on") ||
    value.length > 2_000 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f<>`]/u.test(value)
  ) {
    throw new VisualMediaValidationError("unsafe_svg");
  }
  if (normalizedName === "xmlns") {
    if (!root || value !== "http://www.w3.org/2000/svg") {
      throw new VisualMediaValidationError("unsafe_svg");
    }
    return;
  }
  if (
    /(?:javascript|vbscript|data|file|https?):/iu.test(value) ||
    /(?:^|[^:])\/\//u.test(value) ||
    /url\s*\(/iu.test(value)
  ) {
    throw new VisualMediaValidationError("unsafe_svg");
  }
  if (normalizedName === "viewbox") {
    const dimensions = value
      .trim()
      .split(/[\s,]+/u)
      .map(Number);
    if (
      dimensions.length !== 4 ||
      dimensions.some((dimension) => !Number.isFinite(dimension)) ||
      dimensions[2]! <= 0 ||
      dimensions[3]! <= 0 ||
      dimensions[2]! > MAX_SVG_VIEWBOX_EDGE ||
      dimensions[3]! > MAX_SVG_VIEWBOX_EDGE ||
      dimensions[2]! * dimensions[3]! > MAX_SVG_VIEWBOX_AREA
    ) {
      throw new VisualMediaValidationError("unsafe_svg");
    }
  }
  if (normalizedName === "width" || normalizedName === "height") {
    const dimension = Number(value.replace(/px$/iu, ""));
    if (
      !Number.isFinite(dimension) ||
      dimension <= 0 ||
      dimension > MAX_SVG_VIEWBOX_EDGE
    ) {
      throw new VisualMediaValidationError("unsafe_svg");
    }
  }
  if (
    (normalizedName === "d" || normalizedName === "points") &&
    value.length > 100_000
  ) {
    throw new VisualMediaValidationError("unsafe_svg");
  }
}

/**
 * This is deliberately a small, fail-closed SVG profile rather than a
 * best-effort HTML sanitizer. It accepts the primitives needed for charts and
 * diagrams and rejects scripts, styles, foreign content, links, references,
 * namespaces, processing instructions, and unknown markup.
 */
export function assertSafeSvg(bytes: Uint8Array) {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new VisualMediaValidationError("unsafe_svg");
  }
  if (
    source.length === 0 ||
    source.charCodeAt(0) === 0xfeff ||
    /<!doctype|<!entity|<!\[cdata\[|<\?|<!--|<script|<foreignobject/iu.test(
      source,
    )
  ) {
    throw new VisualMediaValidationError("unsafe_svg");
  }

  const stack: string[] = [];
  const tokenPattern = /<[^>]+>/gu;
  let cursor = 0;
  let rootSeen = false;
  let rootClosed = false;
  let nodeCount = 0;
  let textCharacters = 0;
  let rootHasViewBox = false;
  for (const match of source.matchAll(tokenPattern)) {
    const token = match[0];
    const start = match.index;
    const between = source.slice(cursor, start);
    textCharacters += between.length;
    if (
      between.includes("<") ||
      (stack.length === 0 && between.trim().length > 0) ||
      textCharacters > 100_000
    ) {
      throw new VisualMediaValidationError("unsafe_svg");
    }
    cursor = start + token.length;

    const closing = /^<\/([A-Za-z][A-Za-z0-9]*)\s*>$/u.exec(token);
    if (closing) {
      const name = closing[1]!.toLowerCase();
      if (stack.pop() !== name) {
        throw new VisualMediaValidationError("unsafe_svg");
      }
      if (stack.length === 0) rootClosed = true;
      continue;
    }

    const opening = /^<([A-Za-z][A-Za-z0-9]*)([\s\S]*?)(\/?)>$/u.exec(token);
    if (!opening) throw new VisualMediaValidationError("unsafe_svg");
    const name = opening[1]!.toLowerCase();
    const selfClosing = opening[3] === "/";
    if (
      !SVG_TAGS.has(name) ||
      rootClosed ||
      (!rootSeen && name !== "svg") ||
      (rootSeen && stack.length === 0)
    ) {
      throw new VisualMediaValidationError("unsafe_svg");
    }
    const isRoot = !rootSeen;
    if (isRoot) rootSeen = true;
    nodeCount += 1;
    if (nodeCount > MAX_SVG_NODES || stack.length + 1 > MAX_SVG_DEPTH) {
      throw new VisualMediaValidationError("unsafe_svg");
    }

    const attributes = opening[2] ?? "";
    const attributePattern =
      /([A-Za-z][A-Za-z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu;
    const names = new Set<string>();
    let attributeCursor = 0;
    for (const attribute of attributes.matchAll(attributePattern)) {
      const gap = attributes.slice(attributeCursor, attribute.index);
      if (gap.trim().length > 0) {
        throw new VisualMediaValidationError("unsafe_svg");
      }
      attributeCursor =
        attribute.index + attribute[0].length;
      const attributeName = attribute[1]!.toLowerCase();
      if (names.has(attributeName)) {
        throw new VisualMediaValidationError("unsafe_svg");
      }
      names.add(attributeName);
      if (isRoot && attributeName === "viewbox") rootHasViewBox = true;
      if (names.size > MAX_SVG_ATTRIBUTES_PER_NODE) {
        throw new VisualMediaValidationError("unsafe_svg");
      }
      assertSafeAttribute(
        attributeName,
        attribute[2] ?? attribute[3] ?? "",
        isRoot,
      );
    }
    if (attributes.slice(attributeCursor).trim().length > 0) {
      throw new VisualMediaValidationError("unsafe_svg");
    }
    if (!selfClosing) stack.push(name);
    if (selfClosing && isRoot) rootClosed = true;
  }
  if (
    !rootSeen ||
    !rootClosed ||
    !rootHasViewBox ||
    stack.length > 0 ||
    source.slice(cursor).trim().length > 0
  ) {
    throw new VisualMediaValidationError("unsafe_svg");
  }
}

function normalizeMediaType(value: string): VisualMediaType {
  const normalized = value.trim().toLowerCase();
  if (!VISUAL_MEDIA_EXTENSIONS.has(normalized)) {
    throw new VisualMediaValidationError("media_type_unsupported");
  }
  return normalized as VisualMediaType;
}

function toHex(bytes: Uint8Array) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}

export async function verifyVisualMedia(
  bytes: Uint8Array,
  expectedMediaType: string,
) {
  const mediaType = normalizeMediaType(expectedMediaType);
  if (bytes.length < 1 || bytes.length > MAX_VISUAL_BYTES) {
    throw new VisualMediaValidationError("media_size_invalid");
  }
  switch (mediaType) {
    case "image/png":
      assertPng(bytes);
      break;
    case "image/jpeg":
      assertJpeg(bytes);
      break;
    case "image/webp":
      assertWebp(bytes);
      break;
    case "image/svg+xml":
      assertSafeSvg(bytes);
      break;
    case "video/mp4":
      assertMp4(bytes);
      break;
  }
  const digestInput = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(digestInput).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", digestInput);
  return {
    mediaType,
    sha256: toHex(new Uint8Array(digest)),
    sizeBytes: bytes.length,
  };
}
