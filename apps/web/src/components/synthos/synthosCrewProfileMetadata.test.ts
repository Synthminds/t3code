import { expect, it } from "vite-plus/test";
import { refreshCrewProfileMetadata } from "./synthosCrewProfileMetadata";

it("preserves edited metadata while adopting remote changes to untouched fields after a conflict", () => {
  const previous = { name: "Night crew", description: "Original description" };
  const latest = { name: "Remote name", description: "Updated remotely" };
  expect(
    refreshCrewProfileMetadata(previous, { ...previous, name: "My pending edit" }, latest),
  ).toEqual({
    name: "My pending edit",
    description: "Updated remotely",
  });
  expect(refreshCrewProfileMetadata(previous, { ...previous, description: "" }, latest)).toEqual({
    name: "Remote name",
    description: "",
  });
});
