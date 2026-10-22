// Manifest destinations and storage adapters share SD-relative path syntax.
export function relativePath(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > 400 ||
      /[\\:<>"|?*\x00-\x1f]/.test(value) ||
      value.split("/").some(part => !part || part === "." || part === ".." || /[. ]$/.test(part) || part.toLowerCase() === ".switchpack-running")) {
    throw new Error(`Unsafe relative path: ${String(value)}`);
  }
}

export function destination(value: unknown): asserts value is string {
  relativePath(value);
  const lower = value.toLowerCase();
  if (lower === "switch/.switchpack" || lower.startsWith("switch/.switchpack/") || lower === "switch") {
    throw new Error(`Destination overlaps switchpack backup storage: ${value}`);
  }
}
