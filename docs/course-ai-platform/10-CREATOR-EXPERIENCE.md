# Creator Experience

## This Week

Answer-first cards: top questions, biggest confusion, new Hot Students/opportunities, content gaps, usage trend and wins. Each card states time window, data-through time, coverage/limitations and links to evidence.

## Required areas

- **Questions:** ranked clusters/trends, Confusion Map, Content Gaps, low-confidence/low-rated review.
- **Students:** searchable/filterable list; detail with identity tier, memory, progress, conversations, signals and opportunities.
- **Opportunities:** review queue and evidence-rich detail; lifecycle actions and false-positive feedback.
- **Courses & Knowledge:** course workspace, outline/lesson editor, bulk drag/drop and connectors, source/document/job status, extraction/chunk viewer, ask-the-KB and Diagram Curation Gallery.
- **Assistant Studio:** sectioned Voice Guide/instructions, draft/version/rollback, policy-gated model controls.
- **Playground:** active vs draft side-by-side using identical question/context; retrieved sources, latency and estimated cost.
- **Widget Setup:** accessible branding preview, Circle/generic snippet, webhook steps, install verification and degraded-plan guidance.

## Fast course operations

The default path is optimized for low hands-on time:

1. Create a course shell from a minimal form or reusable tenant template.
2. Drag/drop one or many files, paste content, or connect a supported source.
3. Automatically classify, extract, normalize, deduplicate and propose course/module/lesson placement.
4. Show a plain-language review queue for low-confidence structure, failed extraction, duplicates, sensitive content and diagram candidates.
5. Preview grounded answers and retrieval coverage against the draft version.
6. Publish one atomic knowledge version, with background indexing progress and a safe prior version until the new one is ready.

Editing supports rich text plus source view, autosave, version history, keyboard-first bulk operations and reusable cleanup recipes. A Creator can clean formatting, remove repeated headers/footers, merge/split lessons, correct transcripts, replace a source, or re-ingest only affected content. Before any destructive or broad reprocessing action, show the scope, estimated cost, downstream impact and rollback point.

Experience targets, measured in usability tests on supported hardware and a healthy connection:

- create a course and start its first upload in at most five minutes of hands-on time;
- publish a single small lesson correction in at most two minutes of hands-on time, excluding asynchronous processing;
- initiate a selective re-ingest from a failed job or source detail in at most three deliberate actions;
- complete ordinary course operations without SQL, scripts or platform-owner assistance.

The same operations are available to authorized automation through the [management MCP](14-MCP-AND-TOOLS-ARCHITECTURE.md#platform-management-mcp), using identical validation, job state and audit semantics.

## Safety and continuity

Creator actions use optimistic UI only when rollback/idempotency exists. Publishing requires validation and an audit note. Impersonation is owner-only and displays a persistent banner. Permission-limited viewers see explanations, not disabled controls that imply authority.

The prototype must cover This Week, Hot Student/detail, Questions/Confusion/Content Gaps, Student detail, Studio/Playground, course create/edit/clean/re-ingest, Gallery and Widget Setup with the complete [state matrix](07-UX-INFORMATION-ARCHITECTURE.md#universal-screen-contract).
