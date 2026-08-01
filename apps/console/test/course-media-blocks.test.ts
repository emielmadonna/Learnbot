import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  normalizeCourseMediaContent,
  normalizeImageUrl,
  normalizeLinkUrl,
  normalizeVideoSource,
} from "../src/lib/content/media-block";

const route = readFileSync(
  new URL("../src/app/api/authoring/route.ts", import.meta.url),
  "utf8",
);
const editor = readFileSync(
  new URL("../src/components/sections/course-panel.tsx", import.meta.url),
  "utf8",
);
const renderer = readFileSync(
  new URL(
    "../src/components/ui/rich-text/learning-block.tsx",
    import.meta.url,
  ),
  "utf8",
);
const migration = readFileSync(
  new URL(
    "../../../infra/supabase/migrations/20260731024500_secure_course_media_blocks.sql",
    import.meta.url,
  ),
  "utf8",
);
const authoringMigration = readFileSync(
  new URL(
    "../../../infra/supabase/migrations/20260725122000_course_editing.sql",
    import.meta.url,
  ),
  "utf8",
);
const mediaPolicy = readFileSync(
  new URL("../src/lib/content/media-block.ts", import.meta.url),
  "utf8",
);

test("media URLs accept public HTTPS and reject local or credentialed origins", () => {
  assert.equal(
    normalizeImageUrl("https://cdn.example.com/lesson/diagram.webp"),
    "https://cdn.example.com/lesson/diagram.webp",
  );
  assert.equal(
    normalizeLinkUrl("https://docs.example.com/guide#practice"),
    "https://docs.example.com/guide#practice",
  );

  for (const unsafe of [
    "http://cdn.example.com/image.png",
    "https://localhost/image.png",
    "https://course.internal/image.png",
    "https://10.0.0.9/image.png",
    "https://127.0.0.1/image.png",
    "https://169.254.169.254/latest/meta-data",
    "https://192.168.1.5/image.png",
    "https://user:secret@cdn.example.com/image.png",
    "https://cdn.example.com:8443/image.png",
  ]) {
    assert.equal(normalizeImageUrl(unsafe), null, unsafe);
  }
});

test("video URLs are reduced to allowlisted providers or direct video files", () => {
  assert.deepEqual(
    normalizeVideoSource("https://youtu.be/dQw4w9WgXcQ?t=20"),
    {
      provider: "youtube",
      url: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    },
  );
  assert.deepEqual(
    normalizeVideoSource("https://vimeo.com/76979871"),
    {
      provider: "vimeo",
      url: "https://player.vimeo.com/video/76979871",
    },
  );
  assert.deepEqual(
    normalizeVideoSource("https://media.example.com/lessons/recap.mp4?v=4"),
    {
      provider: "file",
      url: "https://media.example.com/lessons/recap.mp4?v=4",
    },
  );
  assert.equal(
    normalizeVideoSource("https://untrusted.example.com/embed/player"),
    null,
  );
});

test("stored media shapes are bounded and discard unrecognized metadata", () => {
  assert.deepEqual(
    normalizeCourseMediaContent("image", {
      url: "https://cdn.example.com/diagram.png",
      altText: "A three-step pricing diagram",
      caption: "Use this before the pricing conversation.",
      arbitraryHtml: "<script>never persisted</script>",
    }),
    {
      url: "https://cdn.example.com/diagram.png",
      altText: "A three-step pricing diagram",
      caption: "Use this before the pricing conversation.",
    },
  );
  assert.equal(
    normalizeCourseMediaContent("link", {
      url: "https://localhost/admin",
      label: "Unsafe",
      description: "",
    }),
    null,
  );
});

test("authoring, database, editor, and learner renderer share the media contract", () => {
  for (const blockType of ["image", "video", "link"]) {
    assert.match(route, new RegExp(`"${blockType}"`, "u"));
    assert.match(editor, new RegExp(`${blockType}: "[A-Z]`, "u"));
    assert.match(
      migration,
      new RegExp(`when '${blockType}' then`, "u"),
    );
  }
  assert.match(route, /normalizeCourseMediaContent/u);
  assert.match(migration, /app_private[.]authoring_safe_https_url/u);
  assert.match(migration, /content -> 'altText'/u);
  assert.match(migration, /content -> 'description'/u);
  assert.match(migration, /'sourceLabel', 'provider'/u);
  assert.match(authoringMigration, /learning_create_content_block/u);
  assert.match(authoringMigration, /learning_update_content_block/u);
  assert.match(renderer, /referrerPolicy="no-referrer"/u);
  assert.match(renderer, /normalizeCourseMediaContent/u);
  assert.match(mediaPolicy, /youtube-nocookie/u);
  assert.match(renderer, /rel="external nofollow noopener noreferrer"/u);
  assert.doesNotMatch(renderer, /dangerouslySetInnerHTML/u);
});
