import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  cursorAgentToClaude,
  cursorRuleToClaude,
  findDrift,
  splitFrontmatter,
  splitGlobs,
  transformReferences,
  validateRepository,
} from "./sync-ai-rules.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(file) {
  return fs.readFileSync(path.join(rootDir, file), "utf8");
}

describe("splitGlobs", () => {
  it("splits on top-level commas and keeps brace alternatives together", () => {
    assert.deepEqual(splitGlobs("**/*.{test,spec}.{ts,tsx},**/tests/**,**/vitest.config.*"), [
      "**/*.{test,spec}.{ts,tsx}",
      "**/tests/**",
      "**/vitest.config.*",
    ]);
  });

  it("returns no globs for an empty value", () => {
    assert.deepEqual(splitGlobs(""), []);
  });
});

describe("transformReferences", () => {
  it("maps rule, skill, and rule-file references to the Claude tree", () => {
    assert.equal(
      transformReferences("See `.cursor/rules/20-backend-architecture.mdc` and `.cursor/skills/verify/SKILL.md`."),
      "See `.claude/rules/20-backend-architecture.md` and `.claude/skills/verify/SKILL.md`.",
    );
    assert.equal(transformReferences("see `40-security-general.mdc`"), "see `40-security-general.md`");
  });

  it("leaves the shared review contract and the plans location alone", () => {
    const text = "`.cursor/BUGBOT.md`, `backend/.cursor/BUGBOT.md`, `.cursor/plans/x.plan.md`, `review.mdc`";
    assert.equal(transformReferences(text), text);
  });
});

describe("cursorRuleToClaude", () => {
  it("turns a path-scoped rule into a paths frontmatter with the same globs", () => {
    const output = cursorRuleToClaude(
      "---\ndescription: TypeScript style\nalwaysApply: false\nglobs: \"**/*.{ts,tsx}\"\n---\n\n# TypeScript\n",
    );
    assert.equal(output, '---\npaths: ["**/*.{ts,tsx}"]\n---\n\n# TypeScript\n');
  });

  it("writes an always-on rule without frontmatter", () => {
    const output = cursorRuleToClaude("---\ndescription: Governance\nalwaysApply: true\n---\n\n# Governance\n");
    assert.equal(output, "# Governance\n");
  });

  it("rejects a rule that sets both alwaysApply and a path scope", () => {
    assert.throws(
      () => cursorRuleToClaude("---\nalwaysApply: true\nglobs: backend/**\n---\n\n# X\n"),
      /alwaysApply and globs/,
    );
  });
});

describe("cursorAgentToClaude", () => {
  it("uses the Claude model, color, and tools of the review plugin", () => {
    const output = cursorAgentToClaude(
      "bugbot-reviewer",
      "---\nname: bugbot-reviewer\ndescription: Runs the `.cursor/rules/` checks.\nmodel: inherit\nreadonly: true\n---\n\nBody with `.cursor/rules/00-governance.mdc`.\n",
    );
    assert.match(output, /^---\nname: bugbot-reviewer\n/);
    assert.match(output, /description: Runs the `\.claude\/rules\/` checks\./);
    assert.match(output, /model: opus\ncolor: red\ntools: \["Bash", "Glob", "Grep", "Read", "Skill"\]\n---/);
    assert.match(output, /`\.claude\/rules\/00-governance\.md`/);
    assert.ok(!output.includes("readonly"));
  });

  it("loads a skill with the Skill tool when the agent has it, and reads the file otherwise", () => {
    const body = "1. Read `.cursor/skills/code-review/SKILL.md` and follow it.\n";
    const withSkill = cursorAgentToClaude("bugbot-reviewer", `---\nname: bugbot-reviewer\ndescription: x\n---\n\n${body}`);
    assert.match(
      withSkill,
      /Load the skill with the Skill tool\. If the Skill tool is unavailable, read `\.claude\/skills\/code-review\/SKILL\.md` and follow it\./,
    );
    const withoutSkill = cursorAgentToClaude("comment-analyzer", `---\nname: comment-analyzer\ndescription: x\n---\n\n${body}`);
    assert.match(withoutSkill, /Read `\.claude\/skills\/code-review\/SKILL\.md` and follow it\./);
  });

  it("rejects an agent that has no Claude fields", () => {
    assert.throws(
      () => cursorAgentToClaude("unknown-agent", "---\nname: unknown-agent\ndescription: x\n---\n\nbody\n"),
      /no Claude fields/,
    );
  });
});

describe("splitFrontmatter", () => {
  it("returns the body when there is no frontmatter", () => {
    assert.deepEqual(splitFrontmatter("# Title\n"), { data: {}, body: "# Title\n" });
  });
});

describe("repository state", () => {
  it("keeps the Claude tree a faithful mirror of the Cursor canonical files", () => {
    assert.deepEqual(findDrift(rootDir), []);
  });

  it("has no rule whose path scope matches no tracked file", () => {
    assert.deepEqual(validateRepository(rootDir), []);
  });

  it("loads only the approved rules on every session", () => {
    const alwaysOn = fs
      .readdirSync(path.join(rootDir, ".cursor/rules"))
      .filter((file) => file.endsWith(".mdc"))
      .filter((file) => /^alwaysApply: true$/m.test(splitFrontmatterText(read(`.cursor/rules/${file}`))))
      .map((file) => file.slice(0, 2))
      .sort();
    assert.deepEqual(alwaysOn, ["15", "40"]);
  });

});

function splitFrontmatterText(text) {
  return /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, "\n"))?.[1] ?? "";
}
