export function GET() {
  return Response.json({
    service: "course-ai-console",
    status: "healthy",
    mode: "development"
  });
}
