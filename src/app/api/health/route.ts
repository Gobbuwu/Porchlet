// Liveness check for hosts and uptime monitors. Returns no data about the instance.
export function GET() {
  return Response.json({ ok: true });
}
