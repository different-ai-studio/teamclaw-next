import { BackendError } from "../errors";

export function createUnsupportedPocketBaseService<T extends object>(serviceName: string): T {
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property !== "string") return undefined;
        return () =>
          Promise.reject(
            new BackendError({
              category: "Unsupported",
              operation: `pocketbase.${serviceName}.${property}`,
              message: `PocketBase ${serviceName}.${property} is not supported in phase 1.`,
            }),
          );
      },
    },
  ) as T;
}
