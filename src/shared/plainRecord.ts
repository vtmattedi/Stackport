/** An object with no prototype, for maps keyed by names a project chooses (service names,
 *  network names). Compose allows a service called `__proto__`; on a normal object,
 *  `record["__proto__"] = value` sets the prototype and the entry silently disappears. */
export function plainRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}
