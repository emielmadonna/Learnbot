import { NextResponse } from "next/server";
import { AuthenticationBoundaryError, requireVerifiedUser } from "../../../../../../lib/supabase/auth-boundary";
import { authenticatedLearningClient } from "../../../../../../lib/supabase/learning-route";
import { answerGroundedLearningQuestion, type GroundingSource } from "../../../../../../lib/learning-provider";
import { isTenantId } from "../../../../../../lib/supabase/platform-admin-rpc";

function json(body: unknown, status = 200) { return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } }); }
function record(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function text(value: unknown, fallback = "") { return typeof value === "string" ? value : fallback; }
function source(tenantId: string, title: string, excerpt: string, index: number): GroundingSource {
  return { chunkId: `platform-${tenantId}-${index}`, courseId: `platform-${tenantId}`, courseTitle: "Workspace signals", documentId: `platform-document-${tenantId}`, documentTitle: title, contentHash: "platform-admin-context", excerpt, lessonId: null, lessonTitle: null, sectionName: "Client workspace context" };
}
function errorResponse(error: unknown) { return error instanceof AuthenticationBoundaryError ? json({ ok: false, code: "authentication_required" }, 401) : json({ ok: false, code: "request_denied", message: "The workspace assistant could not answer." }, 400); }

export async function POST(request: Request, { params }: { params: Promise<{ tenantId: string }> }) {
  try {
    const { tenantId } = await params;
    if (!isTenantId(tenantId)) return json({ ok: false, code: "invalid_request" }, 400);
    const supabase = await authenticatedLearningClient(request, { mutation: true });
    await requireVerifiedUser(supabase);
    const authorized = await supabase.rpc("platform_admin_is_authorized");
    if (authorized.error || authorized.data !== true) return json({ ok: false, code: "access_denied" }, 403);
    const input = record(await request.json());
    const question = text(input?.question).trim();
    if (question.length < 2 || question.length > 2_000) return json({ ok: false, code: "invalid_request" }, 400);

    const detailResponse = await supabase.rpc("platform_admin_client_detail", { target_tenant_id: tenantId });
    const detail = record(detailResponse.data);
    if (detailResponse.error || detail?.ok !== true) return json({ ok: false, code: "client_not_found" }, 404);
    const client = record(detail.client) ?? {};
    const counts = record(detail.counts) ?? {};
    const courses = Array.isArray(detail.courses) ? detail.courses : [];
    const people = Array.isArray(detail.people) ? detail.people : [];
    const clientName = text(client.displayName, "this workspace");
    const courseContext = courses.slice(0, 50).map((item) => { const row = record(item) ?? {}; return `${text(row.title, "Untitled course")} (${text(row.status, "unknown")}, ${Number(row.lessons) || 0} lessons, ${Number(row.sources) || 0} sources)`; }).join("; ");
    const peopleContext = people.slice(0, 50).map((item) => { const row = record(item) ?? {}; return `${text(row.name, "Unnamed learner")} · ${text(row.role, "student")} · ${text(row.signal, "building momentum")} · ${Number(row.questions) || 0} questions · ${row.percentComplete == null ? "progress unknown" : `${Number(row.percentComplete) || 0}% complete`}`; }).join("; ");
    const sources = [
      source(tenantId, "Workspace overview", `${clientName} has ${Number(counts.courses) || 0} courses, ${Number(counts.publishedCourses) || 0} published courses, ${Number(counts.knowledgeChunks) || 0} knowledge chunks, ${Number(counts.people) || 0} people, and ${Number(counts.questions) || 0} recorded student questions.`, 1),
      source(tenantId, "Published learning", courseContext || "No course rows are available yet.", 2),
      source(tenantId, "Learner signals", peopleContext || "No learner signal rows are available yet.", 3),
    ];
    const session = await supabase.auth.getSession();
    const authorization = request.headers.get("authorization") ?? (session.data.session?.access_token ? `Bearer ${session.data.session.access_token}` : undefined);
    const configuredModel = text((record(detail.providerVoice) ?? {}).model);
    const model = /^gpt-[a-z0-9._:-]{2,120}$/iu.test(configuredModel) ? configuredModel : "gpt-4o-mini";
    const answer = await answerGroundedLearningQuestion({ assistantName: text((record(detail.branding) ?? {}).assistantName, "Workspace assistant"), tenantId, actorId: session.data.session?.user.id ?? "platform-admin", requestId: `platform-assistant:${crypto.randomUUID()}`, traceId: `platform-assistant:${crypto.randomUUID()}`, idempotencyKey: `platform-assistant:${crypto.randomUUID()}`, question, intent: "explain", scopeLabel: `${clientName} workspace signals`, history: [], sources, provider: "openai", model, supabase, authorization });
    return json({ ok: true, tenantId, answer: answer.answer, sources: sources.map((item) => ({ title: item.documentTitle, excerpt: item.excerpt })) });
  } catch (error) { return errorResponse(error); }
}
