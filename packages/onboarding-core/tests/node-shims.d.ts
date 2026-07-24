declare module "node:assert/strict" {
  interface Assert {
    deepEqual(actual: unknown, expected: unknown): void;
    equal(actual: unknown, expected: unknown): void;
    match(actual: string, expected: RegExp): void;
    rejects(
      callback: () => Promise<unknown>,
      expected?: (error: unknown) => boolean,
    ): Promise<void>;
  }
  const assert: Assert;
  export default assert;
}

declare module "node:test" {
  type TestBody = () => void | Promise<void>;
  export default function test(name: string, body: TestBody): void;
}
