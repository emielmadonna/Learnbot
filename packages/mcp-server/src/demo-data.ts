export const DEVELOPMENT_TENANT_ID = "tenant_estie_demo";

export const developmentCourses = [
  {
    courseId: "course_marketing_magic",
    tenantId: DEVELOPMENT_TENANT_ID,
    title: "Marketing Magic",
    status: "draft",
    modules: 8,
    lessons: 68,
    activeVersion: 3,
    draftVersion: 4,
    updatedAt: "2026-07-23T21:00:00.000Z"
  },
  {
    courseId: "course_idea_to_income",
    tenantId: DEVELOPMENT_TENANT_ID,
    title: "Idea to Income",
    status: "published",
    modules: 6,
    lessons: 41,
    activeVersion: 2,
    draftVersion: null,
    updatedAt: "2026-07-23T20:40:00.000Z"
  }
] as const;

export const developmentJobs = [
  {
    jobId: "job_marketing_magic_v4",
    tenantId: DEVELOPMENT_TENANT_ID,
    courseId: "course_marketing_magic",
    status: "running",
    currentStage: "document.chunk",
    completedItems: 51,
    totalItems: 68,
    issues: 2,
    updatedAt: "2026-07-23T21:10:00.000Z"
  }
] as const;

export const buildPlan = {
  sprint: "four-day vertical slice",
  sharedConsole: "http://127.0.0.1:3100",
  lanes: [
    "platform control plane",
    "learning pipeline",
    "product experience"
  ],
  boundary:
    "The sprint proves one tenant/course path; it does not claim enterprise production readiness."
} as const;
