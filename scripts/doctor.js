const expectedNode = "22.19.0";
const expectedPnpm = "11.2.2";

const actualNode = process.versions.node;
const userAgent = process.env.npm_config_user_agent || "";
const pnpmVersion = userAgent.match(/pnpm\/([^ ]+)/)?.[1] || null;

console.log(`node ${actualNode}`);

if (actualNode !== expectedNode) {
  console.error(`Expected Node ${expectedNode}; run: volta install node@${expectedNode}`);
  process.exitCode = 1;
}

if (!pnpmVersion) {
  console.error("Expected to run this check through pnpm.");
  process.exitCode = 1;
} else {
  console.log(`pnpm ${pnpmVersion}`);
  if (pnpmVersion !== expectedPnpm) {
    console.error(`Expected pnpm ${expectedPnpm}; run: volta install pnpm@${expectedPnpm}`);
    process.exitCode = 1;
  }
}
