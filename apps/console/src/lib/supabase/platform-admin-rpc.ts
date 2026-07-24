import type { SupabaseClient } from "@supabase/supabase-js";

export type PlatformClientSummary = {
  tenantId: string;
  slug: string;
  displayName: string;
  status: string;
  region: string | null;
  assistantName: string;
  courses: number;
  publishedCourses: number;
  members: number;
  sources: number;
  knowledgeChunks: number;
  updatedAt: string;
};

export type PlatformOverview = {
  ok: true;
  dataMode: "durable";
  generatedAt: string;
  totals: {
    tenants: number;
    activeTenants: number;
    courses: number;
    members: number;
    sources: number;
    knowledgeChunks: number;
  };
  tenants: PlatformClientSummary[];
};

export type PlatformClientDetail = {
  ok: true;
  dataMode: "durable";
  generatedAt: string;
  client: {
    tenantId: string;
    slug: string;
    displayName: string;
    status: string;
    region: string | null;
    assistantName: string;
    updatedAt: string;
  };
  branding: {
    assistantName: string;
    primaryColor: string;
    accentColor: string;
    surfaceColor: string;
    textColor: string;
    iconKey: string;
  };
  providerVoice: {
    provider: string;
    model: string;
    credentials: string;
    voiceEnabled: boolean;
    voiceId: string;
  };
  features: {
    analytics: boolean;
    voice: boolean;
    uploads: boolean;
    contextMapping: boolean;
  };
  counts: {
    courses: number;
    publishedCourses: number;
    modules: number;
    lessons: number;
    sources: number;
    documents: number;
    knowledgeChunks: number;
    people: number;
    activePeople: number;
    questions: number;
  };
  courses: Array<{
    courseId: string;
    title: string;
    status: string;
    updatedAt: string;
    modules: number;
    lessons: number;
    sources: number;
  }>;
  people: Array<{
    personId: string;
    name: string;
    role: string;
    status: string;
    progressState: string | null;
    percentComplete: number | null;
    lastActivityAt: string | null;
    questions: number;
    signal: string;
  }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function number(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function string(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function nullableString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function boolean(value: unknown, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

export function isTenantId(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

export function parsePlatformOverview(value: unknown): PlatformOverview | null {
  if (!isRecord(value) || value.ok !== true || value.dataMode !== "durable") {
    return null;
  }
  const totals = isRecord(value.totals) ? value.totals : {};
  const tenants = Array.isArray(value.tenants) ? value.tenants : [];
  return {
    ok: true,
    dataMode: "durable",
    generatedAt: string(value.generatedAt),
    totals: {
      tenants: number(totals.tenants),
      activeTenants: number(totals.activeTenants),
      courses: number(totals.courses),
      members: number(totals.members),
      sources: number(totals.sources),
      knowledgeChunks: number(totals.knowledgeChunks),
    },
    tenants: tenants.flatMap((value) => {
      if (!isRecord(value)) return [];
      return [
        {
          tenantId: string(value.tenantId),
          slug: string(value.slug),
          displayName: string(value.displayName, "Unnamed workspace"),
          status: string(value.status, "unknown"),
          region: nullableString(value.region),
          assistantName: string(value.assistantName, "LearningBot"),
          courses: number(value.courses),
          publishedCourses: number(value.publishedCourses),
          members: number(value.members),
          sources: number(value.sources),
          knowledgeChunks: number(value.knowledgeChunks),
          updatedAt: string(value.updatedAt),
        },
      ];
    }),
  };
}

export function parsePlatformClientDetail(
  value: unknown,
): PlatformClientDetail | null {
  if (!isRecord(value) || value.ok !== true || value.dataMode !== "durable") {
    return null;
  }
  if (
    !isRecord(value.client) ||
    !isRecord(value.branding) ||
    !isRecord(value.providerVoice) ||
    !isRecord(value.features) ||
    !isRecord(value.counts)
  ) return null;
  const client = value.client;
  const branding = value.branding;
  const providerVoice = value.providerVoice;
  const features = value.features;
  const counts = value.counts;
  const courses = Array.isArray(value.courses) ? value.courses : [];
  const people = Array.isArray(value.people) ? value.people : [];

  return {
    ok: true,
    dataMode: "durable",
    generatedAt: string(value.generatedAt),
    client: {
      tenantId: string(client.tenantId),
      slug: string(client.slug),
      displayName: string(client.displayName, "Unnamed workspace"),
      status: string(client.status, "unknown"),
      region: nullableString(client.region),
      assistantName: string(client.assistantName, "LearningBot"),
      updatedAt: string(client.updatedAt),
    },
    branding: {
      assistantName: string(branding.assistantName, "LearningBot"),
      primaryColor: string(branding.primaryColor, "#315F50"),
      accentColor: string(branding.accentColor, "#D8A653"),
      surfaceColor: string(branding.surfaceColor, "#FFFDF8"),
      textColor: string(branding.textColor, "#17211D"),
      iconKey: string(branding.iconKey, "spark"),
    },
    providerVoice: {
      provider: string(providerVoice.provider, "development-local"),
      model: string(providerVoice.model, "deterministic-grounded-v1"),
      credentials: string(providerVoice.credentials, "server_side_only"),
      voiceEnabled: boolean(providerVoice.voiceEnabled, true),
      voiceId: string(providerVoice.voiceId, "harbor"),
    },
    features: {
      analytics: boolean(features.analytics, true),
      voice: boolean(features.voice, true),
      uploads: boolean(features.uploads, true),
      contextMapping: boolean(features.contextMapping, true),
    },
    counts: {
      courses: number(counts.courses),
      publishedCourses: number(counts.publishedCourses),
      modules: number(counts.modules),
      lessons: number(counts.lessons),
      sources: number(counts.sources),
      documents: number(counts.documents),
      knowledgeChunks: number(counts.knowledgeChunks),
      people: number(counts.people),
      activePeople: number(counts.activePeople),
      questions: number(counts.questions),
    },
    courses: courses.flatMap((value) => {
      if (!isRecord(value)) return [];
      return [
        {
          courseId: string(value.courseId),
          title: string(value.title, "Untitled course"),
          status: string(value.status, "unknown"),
          updatedAt: string(value.updatedAt),
          modules: number(value.modules),
          lessons: number(value.lessons),
          sources: number(value.sources),
        },
      ];
    }),
    people: people.flatMap((value) => {
      if (!isRecord(value)) return [];
      return [
        {
          personId: string(value.personId),
          name: string(value.name, "Unnamed learner"),
          role: string(value.role, "student"),
          status: string(value.status, "unknown"),
          progressState: nullableString(value.progressState),
          percentComplete:
            value.percentComplete === null || value.percentComplete === undefined
              ? null
              : number(value.percentComplete),
          lastActivityAt: nullableString(value.lastActivityAt),
          questions: number(value.questions),
          signal: string(value.signal, "building_momentum"),
        },
      ];
    }),
  };
}

export async function getPlatformOverview(supabase: SupabaseClient) {
  const response = await supabase.rpc("platform_admin_overview");
  return response.error ? null : parsePlatformOverview(response.data);
}

export async function getPlatformClientDetail(
  supabase: SupabaseClient,
  tenantId: string,
) {
  const response = await supabase.rpc("platform_admin_client_detail", {
    target_tenant_id: tenantId,
  });
  return response.error ? null : parsePlatformClientDetail(response.data);
}
