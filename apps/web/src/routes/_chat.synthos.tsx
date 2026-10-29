import { createFileRoute } from "@tanstack/react-router";
import { SynthosCockpit } from "../components/synthos/SynthosCockpit";

export const Route = createFileRoute("/_chat/synthos")({
  component: SynthosCockpit,
});
