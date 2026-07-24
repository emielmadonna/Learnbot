export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    {
      service: "learningbot-console",
      status: "healthy",
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
