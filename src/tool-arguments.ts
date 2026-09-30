/** An argument a tool does not declare is refused, not dropped. A dropped key
 * is invisible: `claim_experiment` once discarded a `project` it did not model
 * and reserved an experiment number in the server's own project, reporting
 * success. Every tool's schema lists the keys its handler reads, so the schema
 * is the allowlist. */
export function undeclaredArguments(
  schema: { properties?: Record<string, unknown> },
  args: Record<string, unknown> | undefined,
): string[] {
  const declared = new Set(Object.keys(schema.properties ?? {}));
  return Object.keys(args ?? {}).filter((key) => !declared.has(key));
}
