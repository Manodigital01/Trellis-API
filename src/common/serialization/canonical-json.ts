/** Deterministic JSON serialization for values that participate in hashes/signatures. */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();

  const serialize = (current: unknown): string => {
    if (current === null || typeof current === "string" || typeof current === "boolean") {
      return JSON.stringify(current);
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new TypeError("Canonical JSON numbers must be finite");
      if (Number.isInteger(current) && !Number.isSafeInteger(current)) {
        throw new TypeError("Canonical JSON integers must be safe integers; encode larger values as strings");
      }
      return JSON.stringify(Object.is(current, -0) ? 0 : current);
    }
    if (typeof current !== "object") {
      throw new TypeError(`Unsupported canonical JSON value: ${typeof current}`);
    }
    if (ancestors.has(current)) throw new TypeError("Canonical JSON cannot contain circular references");
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        const items: string[] = [];
        for (let index = 0; index < current.length; index += 1) {
          if (!Object.prototype.hasOwnProperty.call(current, index)) {
            throw new TypeError("Canonical JSON arrays cannot contain holes");
          }
          items.push(serialize(current[index]));
        }
        return `[${items.join(",")}]`;
      }
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError("Canonical JSON objects must be plain objects");
      }
      const record = current as Record<string, unknown>;
      return `{${Object.keys(record).sort().map((key) => {
        if (record[key] === undefined) throw new TypeError("Canonical JSON cannot contain undefined values");
        return `${JSON.stringify(key)}:${serialize(record[key])}`;
      }).join(",")}}`;
    } finally {
      ancestors.delete(current);
    }
  };

  return serialize(value);
}
