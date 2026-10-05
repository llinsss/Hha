import { getSessionUser } from "@/lib/server/auth";

export async function GET() {
  const user = await getSessionUser();
  return Response.json({ user });
}
