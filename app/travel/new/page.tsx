import { PlannerClient } from "./planner-client";

export default async function NewTravelPlanPage({
  searchParams,
}: {
  searchParams: Promise<{ prompt?: string }>;
}) {
  const params = await searchParams;
  return <PlannerClient initialPrompt={params.prompt || ""} />;
}
