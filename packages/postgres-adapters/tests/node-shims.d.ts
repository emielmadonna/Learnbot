declare module "node:assert/strict" {
  const assert: {
    deepEqual(actual: unknown, expected: unknown): void;
    equal(actual: unknown, expected: unknown): void;
    ok(value: unknown): asserts value;
    rejects(
      block: Promise<unknown> | (() => Promise<unknown>),
      error?: (error: unknown) => boolean,
    ): Promise<void>;
  };
  export default assert;
}

declare module "node:test" {
  const test: (
    name: string,
    fn: () => void | Promise<void>,
  ) => void;
  export default test;
}
