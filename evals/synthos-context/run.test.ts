import { expect, it } from "vite-plus/test";
import { grade } from "./grade.ts";

it.each([
  {
    label: "missing required route",
    routes: [],
    notes: ["required"],
    bytes: 200,
    policy: true,
    pass: false,
  },
  {
    label: "missing required memory",
    routes: ["memory"],
    notes: [],
    bytes: 200,
    policy: true,
    pass: false,
  },
  {
    label: "unrelated memory",
    routes: ["memory"],
    notes: ["required", "excluded"],
    bytes: 200,
    policy: true,
    pass: false,
  },
  {
    label: "oversized context",
    routes: ["memory"],
    notes: ["required"],
    bytes: 4097,
    policy: true,
    pass: false,
  },
  {
    label: "missing policy",
    routes: ["memory"],
    notes: ["required"],
    bytes: 200,
    policy: false,
    pass: false,
  },
  {
    label: "complete bounded selection",
    routes: ["memory"],
    notes: ["required"],
    bytes: 200,
    policy: true,
    pass: true,
  },
])("rejects incorrect benchmark results: $label", (entry) => {
  expect(
    grade({
      routes: entry.routes,
      notes: entry.notes,
      expectedRoutes: ["memory"],
      expectedNotes: ["required"],
      excludedNotes: ["excluded"],
      memoryBytes: entry.bytes,
      packetBytes: 1000,
      policyIntact: entry.policy,
    }).pass,
  ).toBe(entry.pass);
});
