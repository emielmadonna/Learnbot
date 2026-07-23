declare module "node:assert/strict" {
  interface Assert {
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    rejects(
      block: Promise<unknown> | (() => Promise<unknown>),
      error?: (error: unknown) => boolean,
    ): Promise<void>;
  }
  const assert: Assert;
  export default assert;
}

declare module "node:test" {
  type TestBody = () => void | Promise<void>;
  export default function test(name: string, body: TestBody): void;
}

declare module "node:crypto" {
  interface Hash {
    update(data: string): Hash;
    digest(encoding: "hex"): string;
  }
  export function createHash(algorithm: "sha256"): Hash;
}
