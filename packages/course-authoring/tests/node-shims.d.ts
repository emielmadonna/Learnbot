declare module "node:test" {
  interface TestContext {
    readonly name: string;
  }
  type TestBody = (context: TestContext) => void | Promise<void>;
  export default function test(name: string, body: TestBody): void;
}

declare module "node:assert/strict" {
  interface Assert {
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    match(value: string, regexp: RegExp, message?: string): void;
    rejects(
      block: (() => Promise<unknown>) | Promise<unknown>,
      error?: RegExp | ((error: unknown) => boolean),
    ): Promise<void>;
  }
  const assert: Assert;
  export default assert;
}
