declare module "node:assert/strict" {
  interface Assert {
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    rejects(
      promise: Promise<unknown>,
      expected?: RegExp | ((error: unknown) => boolean),
    ): Promise<void>;
  }
  const assert: Assert;
  export default assert;
}

declare module "node:test" {
  type TestBody = () => void | Promise<void>;
  export default function test(name: string, body: TestBody): void;
}

declare module "node:fs/promises" {
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
  export function readdir(path: string): Promise<string[]>;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
}

declare const process: {
  cwd(): string;
};
