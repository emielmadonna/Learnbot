import assert from "node:assert/strict";

const baseUrl = process.env.WIDGET_SMOKE_BASE_URL ?? "http://127.0.0.1:3100";

async function read(pathname) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers: { accept: "text/html,application/xhtml+xml,image/svg+xml" },
  });
  assert.equal(response.status, 200, `${pathname} should return 200`);
  return {
    contentType: response.headers.get("content-type") ?? "",
    body: await response.text(),
  };
}

const [lab, host, mark, diagram] = await Promise.all([
  read("/dev/widget"),
  read("/dev/widget/host"),
  read("/widget/northstar-mark.svg"),
  read("/widget/momentum-loop.svg"),
]);

assert.match(lab.body, /Widget Lab/);
assert.match(lab.body, /Test the companion where it actually lives/);
assert.match(host.body, /Your Minimum Day/);
assert.match(host.body, /Loading isolated widget runtime/);
assert.match(mark.contentType, /image\/svg\+xml/);
assert.match(diagram.contentType, /image\/svg\+xml/);
assert.match(diagram.body, /Disruption.*Minimum Day.*Evidence.*Momentum/s);

console.log(
  "Widget development host smoke passed: lab, isolated host, logo and approved diagram are reachable.",
);
