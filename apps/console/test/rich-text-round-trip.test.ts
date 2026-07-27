import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  applyRichTextCommand,
  continueBlockOnEnter,
  type EditorState,
} from "../src/components/ui/rich-text/commands";
import {
  RICH_TEXT_TAGS,
  isMarkdownBlockContent,
  markdownToPlainText,
  parseRichText,
  readRichTextMarkdown,
  richTextBlockContent,
  safeLinkHref,
  sanitizeRichTextMarkdown,
  type RichTextDocument,
  type RichTextNode,
} from "../src/components/ui/rich-text/markdown";

/* ------------------------------------------------------------------------ */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * The whole write path a block takes, with nothing mocked out that changes the
 * bytes: the editor's own content mapper, the shape check `POST /api/authoring`
 * applies to `content`, and the JSON serialisation that jsonb round-trips
 * through on the way to `learning_get_workspace` and back into the workspace
 * payload the console renders from.
 */
function roundTripThroughAuthoring(markdown: string): Record<string, unknown> {
  const content = richTextBlockContent(markdown);

  // `blockContent()` in src/app/api/authoring/route.ts.
  const isRecord =
    Boolean(content) && typeof content === "object" && !Array.isArray(content);
  assert.ok(isRecord, "block content must be a JSON object");
  assert.ok(
    JSON.stringify(content).length <= 100_000,
    "block content must fit the route's size ceiling",
  );

  // Postgres jsonb → learning_get_workspace → LearningBlock.content.
  return JSON.parse(JSON.stringify(content)) as Record<string, unknown>;
}

/** Every tag the document actually uses, so the allowlist can be asserted. */
function tagsIn(document: RichTextDocument): Set<string> {
  const found = new Set<string>();
  const walk = (nodes: RichTextDocument) => {
    for (const node of nodes) {
      if (node.kind !== "element") continue;
      found.add(node.tag);
      walk(node.children);
    }
  };
  walk(document);
  return found;
}

/** Concatenated text of a node tree — what a learner would actually read. */
function textIn(nodes: RichTextDocument): string {
  return nodes
    .map((node) =>
      node.kind === "text" ? node.value : textIn(node.children),
    )
    .join("");
}

function findAll(nodes: RichTextDocument, tag: string): RichTextNode[] {
  const found: RichTextNode[] = [];
  const walk = (list: RichTextDocument) => {
    for (const node of list) {
      if (node.kind !== "element") continue;
      if (node.tag === tag) found.push(node);
      walk(node.children);
    }
  };
  walk(nodes);
  return found;
}

const start = (value: string, at = value.length): EditorState => ({
  value,
  selectionStart: at,
  selectionEnd: at,
});

const select = (
  value: string,
  from: number,
  to: number,
): EditorState => ({ value, selectionStart: from, selectionEnd: to });

/* ------------------------------------------------------------------------ */
/* 1. The editor produces markdown                                           */
/* ------------------------------------------------------------------------ */

test("toolbar commands wrap the selection and toggle back off", () => {
  const bolded = applyRichTextCommand(select("make this bold", 5, 9), "bold");
  assert.equal(bolded.value, "make **this** bold");
  // Selection stays on the text, not on the markers.
  assert.equal(
    bolded.value.slice(bolded.selectionStart, bolded.selectionEnd),
    "this",
  );

  // Applying it again to the same words removes the emphasis.
  const unbolded = applyRichTextCommand(bolded, "bold");
  assert.equal(unbolded.value, "make this bold");
});

test("a link command seeds an allowed protocol and selects the URL", () => {
  const linked = applyRichTextCommand(select("read the docs", 9, 13), "link");
  assert.equal(linked.value, "read the [docs](https://)");
  assert.equal(
    linked.value.slice(linked.selectionStart, linked.selectionEnd),
    "https://",
  );
});

test("list and heading commands act on whole lines and never stack", () => {
  const listed = applyRichTextCommand(select("one\ntwo", 0, 7), "bulletList");
  assert.equal(listed.value, "- one\n- two");

  const numbered = applyRichTextCommand(listed, "numberedList");
  assert.equal(numbered.value, "1. one\n2. two");

  const heading = applyRichTextCommand(start("Overview", 0), "heading2");
  assert.equal(heading.value, "# Overview");
  // Re-applying the other heading level replaces it rather than nesting hashes.
  assert.equal(
    applyRichTextCommand(heading, "heading3").value,
    "## Overview",
  );
});

test("Enter continues a list and an empty item ends it", () => {
  const continued = continueBlockOnEnter(start("1. first"));
  assert.equal(continued?.value, "1. first\n2. ");

  const ended = continueBlockOnEnter(start("1. first\n2. "));
  assert.equal(ended?.value, "1. first\n");

  assert.equal(continueBlockOnEnter(start("ordinary prose")), null);
});

/* ------------------------------------------------------------------------ */
/* 2. Round-trip integrity                                                   */
/* ------------------------------------------------------------------------ */

test("a block authored in the editor survives save, re-read and render", () => {
  // Authored the way the toolbar authors it, not hand-written markdown.
  let state = start("");
  state = applyRichTextCommand(state, "heading2");
  state = { ...state, value: `${state.value}Getting started` };
  state = start(`${state.value}\n`);
  state = { ...state, value: `${state.value}Read the intro carefully.` };
  state = applyRichTextCommand(
    select(state.value, state.value.length - 10, state.value.length - 1),
    "bold",
  );
  const authored = `${state.value}\n\n- One point\n- Two with \`code\`\n\n> Remember this.\n\nSee the [handbook](https://example.com/handbook).`;

  assert.equal(
    authored,
    "# Getting started\nRead the intro **carefully**.\n\n" +
      "- One point\n- Two with `code`\n\n> Remember this.\n\n" +
      "See the [handbook](https://example.com/handbook).",
  );

  const stored = roundTripThroughAuthoring(authored);

  // The stored shape is the one `rich_text` content already declared.
  assert.equal(stored.format, "markdown");
  assert.ok(isMarkdownBlockContent(stored));

  // Byte-for-byte: nothing was rewritten by sanitisation, JSON or re-reading.
  const reread = readRichTextMarkdown(stored);
  assert.equal(reread, authored);

  // And the rendered document is exactly the formatting that was authored.
  const document = parseRichText(reread);
  assert.deepEqual(document, [
    {
      kind: "element",
      tag: "h2",
      children: [{ kind: "text", value: "Getting started" }],
    },
    {
      kind: "element",
      tag: "p",
      children: [
        { kind: "text", value: "Read the intro " },
        {
          kind: "element",
          tag: "strong",
          children: [{ kind: "text", value: "carefully" }],
        },
        { kind: "text", value: "." },
      ],
    },
    {
      kind: "element",
      tag: "ul",
      children: [
        {
          kind: "element",
          tag: "li",
          children: [{ kind: "text", value: "One point" }],
        },
        {
          kind: "element",
          tag: "li",
          children: [
            { kind: "text", value: "Two with " },
            {
              kind: "element",
              tag: "code",
              children: [{ kind: "text", value: "code" }],
            },
          ],
        },
      ],
    },
    {
      kind: "element",
      tag: "blockquote",
      children: [
        {
          kind: "element",
          tag: "p",
          children: [{ kind: "text", value: "Remember this." }],
        },
      ],
    },
    {
      kind: "element",
      tag: "p",
      children: [
        { kind: "text", value: "See the " },
        {
          kind: "element",
          tag: "a",
          children: [{ kind: "text", value: "handbook" }],
          href: "https://example.com/handbook",
        },
        { kind: "text", value: "." },
      ],
    },
  ]);

  // Re-saving an untouched block is a no-op, so a round trip cannot drift.
  assert.equal(readRichTextMarkdown(roundTripThroughAuthoring(reread)), reread);
});

test("a fenced code block keeps its language, indentation and blank lines", () => {
  const authored = "```ts\nconst a = 1;\n\n  const b = 2;\n```";
  const reread = readRichTextMarkdown(roundTripThroughAuthoring(authored));
  assert.equal(reread, authored);

  const [pre] = findAll(parseRichText(reread), "pre");
  assert.ok(pre !== undefined && pre.kind === "element");
  assert.equal(pre.language, "ts");
  assert.equal(textIn(pre.children), "const a = 1;\n\n  const b = 2;");
});

test("plain projection of a document never leaks markdown syntax", () => {
  const plain = markdownToPlainText("## Title\n\n**Bold** and [a link](https://x.test/).");
  assert.equal(plain, "Title\nBold and a link.");
});

/* ------------------------------------------------------------------------ */
/* 3. The renderer's allowlist                                               */
/* ------------------------------------------------------------------------ */

test("every node a document can produce is inside the tag allowlist", () => {
  const document = parseRichText(
    "# h\n## h\n### h\n#### h\n\npara *em* **strong** `code` [x](https://a.test/)\n\n" +
      "- a\n\n1. b\n\n> q\n\n```sh\nls\n```\n\n---\n",
    { citationCount: 3 },
  );
  for (const tag of tagsIn(document)) {
    assert.ok(
      RICH_TEXT_TAGS.has(tag as never),
      `parser produced a tag outside the allowlist: ${tag}`,
    );
  }
  // Deep headings clamp rather than reaching for <h1> or an unknown tag.
  assert.deepEqual(
    parseRichText("#### deep")[0],
    { kind: "element", tag: "h4", children: [{ kind: "text", value: "deep" }] },
  );
});

/* ------------------------------------------------------------------------ */
/* 4. Cross-site scripting                                                   */
/* ------------------------------------------------------------------------ */

test("markup is stripped on write and can never come back as an element", () => {
  const payloads = [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "<svg/onload=alert(1)>",
    "<iframe src=https://evil.test></iframe>",
    "<style>body{display:none}</style>",
    "<a href='javascript:alert(1)'>click</a>",
    "<div onclick=alert(1)>x</div>",
  ];
  for (const payload of payloads) {
    const stored = roundTripThroughAuthoring(`Before ${payload} after`);
    const text = readRichTextMarkdown(stored);
    assert.doesNotMatch(text, /<[a-z]/iu, `markup survived the write: ${payload}`);

    const document = parseRichText(text);
    for (const tag of tagsIn(document)) {
      assert.ok(RICH_TEXT_TAGS.has(tag as never));
    }
    // Whatever is left is prose, not an element.
    assert.equal(findAll(document, "a").length, 0);
  }
});

test("only https, mailto and same-document links are rendered as links", () => {
  assert.equal(safeLinkHref("https://example.com/a"), "https://example.com/a");
  assert.equal(safeLinkHref("mailto:teacher@example.com"), "mailto:teacher@example.com");
  assert.equal(safeLinkHref("#section-two"), "#section-two");

  for (const refused of [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    " javascript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    "vbscript:msgbox(1)",
    "http://example.com/insecure",
    "file:///etc/passwd",
    "https://user:secret@example.com/",
    "https://localhost/admin",
    "https://127.0.0.1/admin",
    "https://10.0.0.5/admin",
    "https://192.168.1.1/admin",
    "https://169.254.169.254/latest/meta-data",
    "https://db.internal/",
    "#1-not-letter-initial",
    "",
  ]) {
    assert.equal(safeLinkHref(refused), null, `should refuse: ${refused}`);
  }
});

test("a refused link keeps its label as prose and renders no anchor", () => {
  const document = parseRichText(
    "Click [here](javascript:alert(document.cookie)) now.",
  );
  assert.equal(findAll(document, "a").length, 0);
  assert.equal(textIn(document), "Click here now.");
});

test("outbound links are marked up defensively by the renderer", () => {
  const source = readFileSync(
    new URL("../src/components/ui/rich-text/rich-text.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /rel: "noopener noreferrer nofollow ugc"/u);
  assert.match(source, /target: "_blank"/u);
});

test("no render surface reaches for dangerouslySetInnerHTML", () => {
  const surfaces = [
    "../src/components/ui/rich-text/rich-text.tsx",
    "../src/components/ui/rich-text/learning-block.tsx",
    "../src/components/ui/rich-text/markdown-editor.tsx",
    "../src/components/sections/course-panel.tsx",
    "../src/components/sections/home-section.tsx",
    "../src/app/app/conversation/conversation-client.tsx",
  ];
  for (const surface of surfaces) {
    const source = readFileSync(new URL(surface, import.meta.url), "utf8");
    // The prop being *used*, not the word appearing in a comment explaining
    // why it is never used.
    assert.doesNotMatch(
      source,
      /dangerouslySetInnerHTML\s*[:=]/u,
      `${surface} must not set inner HTML`,
    );
    assert.doesNotMatch(
      source,
      /\binnerHTML\b/u,
      `${surface} must not assign innerHTML`,
    );
  }
});

/* ------------------------------------------------------------------------ */
/* 5. Assistant answers                                                      */
/* ------------------------------------------------------------------------ */

test("citation markers become references only within the cited range", () => {
  const document = parseRichText("Grounded in the handbook [1] and [7].", {
    citationCount: 3,
  });
  const citations = findAll(document, "sup");
  assert.equal(citations.length, 1);
  assert.ok(citations[0]?.kind === "element");
  assert.equal(citations[0].citation, 1);
  // Out-of-range markers stay literal rather than pointing at nothing.
  assert.match(textIn(document), /\[7\]/u);
});

test("citation markers stay literal when the answer cites nothing", () => {
  const document = parseRichText("An array index like [1] is not a citation.");
  assert.equal(findAll(document, "sup").length, 0);
  assert.match(textIn(document), /\[1\]/u);
});

test("the conversation renders assistant and learner turns differently", () => {
  const source = readFileSync(
    new URL("../src/app/app/conversation/conversation-client.tsx", import.meta.url),
    "utf8",
  );
  // Model output goes through the rich renderer with its sources attached.
  assert.match(source, /citationCount=\{message\.sources\.length\}/u);
  // A learner's own words are printed literally, never parsed as formatting.
  assert.match(source, /<PlainText/u);
  // Sources carry the anchor a citation reference points at.
  assert.match(source, /citationAnchorPrefix\(/u);
});

/* ------------------------------------------------------------------------ */
/* 6. Degrading honestly                                                     */
/* ------------------------------------------------------------------------ */

test("unterminated formatting is shown literally, not swallowed", () => {
  assert.equal(textIn(parseRichText("2 ** 8 is 256")), "2 ** 8 is 256");
  assert.equal(textIn(parseRichText("an unclosed `backtick")), "an unclosed `backtick");
  assert.equal(textIn(parseRichText("[unclosed](https://a.test")), "[unclosed](https://a.test");
});

test("sanitising is idempotent and bounded", () => {
  const once = sanitizeRichTextMarkdown("a\r\nbc".padEnd(30_000, "x"));
  assert.equal(sanitizeRichTextMarkdown(once), once);
  assert.equal(once.length, 20_000);
  assert.match(once, /^a\nbc/u);
});
