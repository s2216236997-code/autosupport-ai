// app/api/ping/route.ts
export async function GET() {
  return new Response('pong', { status: 200 });
}
