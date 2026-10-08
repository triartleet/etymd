import { describe, expect, it } from "vitest"

import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  collectUpstreamBlobs,
  compileAllow,
  compilePatterns,
  isSelfName,
  patternLiteral,
  readScreenable,
  screenText,
  stagedBlobShas,
} from "../src/commands/screen.js"

const patterns = [/AcmeInc/i, /internal\.example\.com/i]

describe("content screen", () => {
  it("flags a pattern hit and an absolute home path, with the line number", () => {
    const home = `/${"Users"}/someone/projects/x` // a fixture, assembled so it is not a literal
    const text = ["clean line", "mentions AcmeInc here", home].join("\n")
    const hits = screenText(text, "doc.md", patterns)
    expect(hits).toHaveLength(2)
    expect(hits[0]).toMatchObject({ file: "doc.md", line: 2 })
    expect(hits[1]).toMatchObject({ line: 3, reason: "absolute home path" })
  })

  it("home paths inside a longer token or a URL are not machine paths", () => {
    // Every fixture is assembled from segments, so no line here is a literal home
    // path for the installed screener that guards this repo's own pushes.
    const u = "Users"
    const h = "home"
    const fixture = `mkdir -p "$ROOT/${h}/projects/x"` // a test's temp root
    const url = `see https://docs.example/${h}/x/ for the page` // a URL segment
    const glued = `foo/${u}/someone/x` // inside another path
    for (const line of [fixture, url, glued]) expect(screenText(line, "f", [])).toHaveLength(0)
    const quoted = `"/${h}/someone/x"`
    const afterEquals = `HOME=/${u}/someone/`
    const afterColon = `PATH=/opt/bin:/${h}/someone/bin`
    const lineStart = `/${u}/someone/projects/x`
    for (const line of [quoted, afterEquals, afterColon, lineStart])
      expect(screenText(line, "f", []).map((h) => h.reason)).toEqual(["absolute home path"])
  })

  it("is case-insensitive — a leak does not stop being one in lower case", () => {
    expect(screenText("acmeinc", "f", patterns)).toHaveLength(1)
  })

  it("PINNED: a line marked `allow-published-string` is exempt", () => {
    // The escape hatch has to be visible IN the diff — a reviewer sees the exemption being
    // granted rather than discovering a silent allowlist elsewhere.
    const hits = screenText("AcmeInc on purpose allow-published-string", "f", patterns)
    expect(hits).toEqual([])
  })

  it("reports one hit per line, not one per matching pattern", () => {
    // Otherwise a line matching three patterns triples the noise for a single fix.
    const hits = screenText("AcmeInc and internal.example.com together", "f", patterns)
    expect(hits).toHaveLength(1)
  })

  it("matches a home path under either /Users or /home", () => {
    // Assembled from parts so this suite does not trip the very screen it tests (and so a
    // repo-wide grep for machine paths does not flag its own fixtures).
    const under = (root: string) => `/${root}/someone/x`
    expect(screenText(under("home"), "f", [])).toHaveLength(1)
    expect(screenText(under("Users"), "f", [])).toHaveLength(1)
    // Not every path is a machine path — /usr/local and repo-relative paths must stay silent.
    expect(screenText("/usr/local/bin/tool", "f", [])).toEqual([])
    expect(screenText("src/core/util.ts", "f", [])).toEqual([])
  })

  it("finds nothing when there is nothing — no patterns means no findings", () => {
    expect(screenText("AcmeInc everywhere", "f", [])).toEqual([])
  })

  it("honours repo-level allow patterns for lines that cannot carry an inline marker", () => {
    // A scanner's own source contains the strings it screens for, and a bundler strips
    // comments — so some exemptions cannot live on the line itself.
    const allow = [{ pattern: /describing its own check/i, isSelfName: false }]
    expect(screenText("AcmeInc, describing its own check", "f", patterns, allow)).toEqual([])
    // The exemption is narrow: an ordinary hit beside it still reports.
    expect(screenText("AcmeInc in plain prose", "f", patterns, allow)).toHaveLength(1)
  })

  it("an allow pattern suppresses a machine path too, not just a listed pattern", () => {
    const home = `/${"Users"}/someone/x`
    expect(screenText(home, "f", [], [{ pattern: /someone/i, isSelfName: false }])).toEqual([])
  })
})

describe("allow-file records", () => {
  it("reads a labeled record: the pattern is the rest of its line, verbatim", () => {
    const { lines: entries } = compileAllow(
      ["pattern ^AcmeInc$", "reason fixture text", "date 2026-08-15", "author maintainer"].join(
        "\n",
      ),
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]?.pattern.source).toBe("^AcmeInc$")
    expect(entries[0]?.reason).toBe("fixture text")
    expect(entries[0]?.date).toBe("2026-08-15")
    expect(entries[0]?.author).toBe("maintainer")
  })

  it("PINNED: a pattern may contain pipes — alternation survives intact", () => {
    // The format this replaces split entries on `|`, so an alternation truncated at its
    // first branch and the rest could masquerade as provenance — a silent narrowing of the
    // gate. Labeled lines cannot express that misparse: the pattern runs to end of line.
    const { lines: entries } = compileAllow(
      [
        "pattern AcmeInc|BetaInc",
        "reason either name",
        "date 2026-08-15",
        "author maintainer",
      ].join("\n"),
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]?.pattern.source).toBe("AcmeInc|BetaInc")
    // Both branches of the alternation suppress, and nothing wider does.
    expect(screenText("BetaInc ships it", "f", [/GammaInc/i], entries)).toEqual([])
    expect(screenText("AcmeInc ships it", "f", [/GammaInc/i], entries)).toEqual([])
    expect(screenText("GammaInc in plain prose", "f", [/GammaInc/i], entries)).toHaveLength(1)
  })

  it("a bare unlabeled line is a complete pattern-only record (self-name shorthand)", () => {
    const { lines: entries } = compileAllow("^widget$")
    expect(entries).toHaveLength(1)
    expect(entries[0]?.pattern.source).toBe("^widget$")
    expect(entries[0]?.reason).toBeUndefined()
  })

  it("comments, blanks and indentation do not become patterns", () => {
    const { lines: entries } = compileAllow(
      ["# a comment", "", "  pattern ^a$  ", "\treason r"].join("\n"),
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]?.pattern.source).toBe("^a$")
    expect(entries[0]?.reason).toBe("r")
  })

  it("malformed regex falls back to a literal match, never a silent drop", () => {
    const { lines: entries } = compileAllow(
      ["pattern ([unclosed", "reason broken", "date 2026-08-15", "author x"].join("\n"),
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]?.pattern.test("a ([unclosed b")).toBe(true)
  })

  it("an orphan provenance line exempts nothing and creates no record", () => {
    // Fail-safe by design: an orphan can only under-exempt, and under-exemption reports
    // its own gap at the door that sees the hit.
    const { lines: entries } = compileAllow(
      ["reason no pattern above me", "pattern ^a$"].join("\n"),
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]?.pattern.source).toBe("^a$")
    expect(entries[0]?.reason).toBeUndefined()
  })

  it("reads several records in sequence, each with its own fields", () => {
    const { lines: entries } = compileAllow(
      [
        "pattern ^a$",
        "reason first",
        "date 2026-08-15",
        "author x",
        "pattern ^b$",
        "reason second",
        "date 2026-08-16",
        "author y",
      ].join("\n"),
    )
    expect(entries).toHaveLength(2)
    expect(entries[1]?.reason).toBe("second")
    expect(entries[1]?.author).toBe("y")
  })

  it("a pattern with spaces runs to the end of the line, not to the first space", () => {
    const { lines: entries } = compileAllow(
      [
        "pattern AcmeInc and its friends",
        "reason prose pattern",
        "date 2026-08-15",
        "author x",
      ].join("\n"),
    )
    expect(entries[0]?.pattern.source).toBe("AcmeInc and its friends")
    expect(screenText("AcmeInc and its friends together", "f", [/AcmeInc/i], entries)).toEqual([])
  })
})

describe("self-name exemption", () => {
  it("drops a pattern that IS the repo's own name, keeps one that merely contains it", () => {
    // A repo has to call itself something in its own README and package name; the
    // cross-project rule is about disclosing OTHER projects.
    expect(isSelfName(/widget/i, ["widget"])).toBe(true)
    expect(isSelfName(/WIDGET/i, ["widget"])).toBe(true)
    // Narrower than the name, or broader than it, both stay active.
    expect(isSelfName(/widget-internal/i, ["widget"])).toBe(false)
    expect(isSelfName(/wid/i, ["widget"])).toBe(false)
  })

  it("PINNED: word-anchored spelling of the same name is still the same name", () => {
    // The regression this pins: a pattern generator started emitting names word-anchored, the
    // exemption compared raw sources, and every self-name silently stopped being exempt — code,
    // comment and test all still reading as correct while repos began reporting their own
    // manifests as leaks. Anchors change where a match may begin, never WHICH string matches.
    expect(isSelfName(/\bwidget\b/i, ["widget"])).toBe(true)
    expect(isSelfName(/\bwidget/i, ["widget"])).toBe(true)
    expect(isSelfName(/widget\b/i, ["widget"])).toBe(true)
    // And still no wider: anchoring a DIFFERENT name does not make it the repo's own.
    expect(isSelfName(/\bgadget\b/i, ["widget"])).toBe(false)
  })

  it("exempts any of the names the repo can prove are its own, and nothing else", () => {
    // Directory, package name and remote basename routinely disagree; each is proof of identity.
    const selves = ["widget", "widget-app", "widget.js"]
    expect(isSelfName(/\bwidget-app\b/i, selves)).toBe(true)
    expect(isSelfName(/\bwidget\.js\b/i, selves)).toBe(true) // escaped metacharacter, still literal
    expect(isSelfName(/\bgadget\b/i, selves)).toBe(false)
    // No provable identity means no exemption — a repo that cannot say what it is gets screened
    // in full rather than trusted.
    expect(isSelfName(/\bwidget\b/i, [])).toBe(false)
  })

  it("never exempts a pattern broader than a single name, however it is spelled", () => {
    // A pattern that can match more than one string is not a name, so it can never be proven to
    // be THIS repo's name — the exemption would be wider than the thing it exempts.
    expect(isSelfName(/wid(get)?/i, ["widget"])).toBe(false)
    expect(isSelfName(/widget|gadget/i, ["widget"])).toBe(false)
    expect(isSelfName(/widge./i, ["widget"])).toBe(false)
    expect(isSelfName(/widget+/i, ["widget"])).toBe(false)
    expect(isSelfName(/widge[t]/i, ["widget"])).toBe(false)
    expect(patternLiteral("widget\\d")).toBeNull()
    expect(patternLiteral("wid\\bget")).toBeNull() // an anchor mid-pattern is not a literal
    expect(patternLiteral("\\bwidget\\b")).toBe("widget")
  })
})

describe("binary files are skipped, not screened", () => {
  // The defect this closes: compressed bytes contain any short sequence
  // eventually, so a short pattern matches inside a binary asset and is reported
  // as a "line" of mojibake. The cost of that noise is not the noise; it is that
  // the gate's answer becomes "bypass again", and a trained-in bypass is what
  // eventually waves a real finding through with the rest.
  const tmp = () => path.join(os.tmpdir(), `etymd-screen-${Math.random().toString(36).slice(2)}`)

  it("reports a file carrying a NUL byte as binary rather than screening its bytes", async () => {
    const f = tmp()
    // A real leak string sits AFTER the NUL, so a screen that reads this file at
    // all would flag it. Skipping is the only way this test passes.
    await fs.writeFile(
      f,
      Buffer.concat([Buffer.from("\x89PNG\r\n"), Buffer.from([0]), Buffer.from("AcmeInc")]),
    )
    expect(await readScreenable(f)).toBe("binary")
    await fs.rm(f, { force: true })
  })

  it("still returns text for a file with no NUL, so the gate does not go blind", async () => {
    const f = tmp()
    await fs.writeFile(f, "Copyright (c) AcmeInc\n")
    const out = await readScreenable(f)
    expect(out).not.toBe("binary")
    expect(screenText(String(out), "notice.txt", patterns)).toHaveLength(1)
    await fs.rm(f, { force: true })
  })

  it("returns null for a file that does not exist — distinct from binary, so the skip can be counted", async () => {
    expect(await readScreenable(tmp())).toBeNull()
  })
})

describe("pattern classes", () => {
  it("defaults every pattern to secret when the file carries no class directive", () => {
    const pats = compilePatterns("alpha\nbeta\n# a comment\ngamma")
    expect(pats.map((p) => p.cls)).toEqual(["secret", "secret", "secret"])
    expect(pats.map((p) => p.re.source)).toEqual(["alpha", "beta", "gamma"])
  })

  it("a `# class: vocabulary` directive switches the class of the lines beneath it, and back", () => {
    const pats = compilePatterns(
      [
        "always-secret",
        "# class: vocabulary",
        "two-factor",
        "# class: secret",
        "guarded-name",
      ].join("\n"),
    )
    expect(pats.map((p) => [p.re.source, p.cls])).toEqual([
      ["always-secret", "secret"],
      ["two-factor", "vocabulary"],
      ["guarded-name", "secret"],
    ])
  })

  it("upstreamOwned drops vocabulary patterns AND the machine-path check — secret patterns stay", () => {
    const pats = [
      { re: /supersecret/i, cls: "secret" as const },
      { re: /two-factor/i, cls: "vocabulary" as const },
    ]
    const home = `/${"Users"}/someone/x` // assembled so the source is not a literal home path
    const text = ["mentions two-factor", "mentions supersecret", home].join("\n")
    // Full screen: all three fire.
    expect(screenText(text, "f", pats, [], false)).toHaveLength(3)
    // Upstream-owned: the vocabulary hit AND the machine path drop — both are already public in the
    // byte-identical upstream file. Only the secret-class hit remains.
    const kept = screenText(text, "f", pats, [], true)
    expect(kept.map((h) => h.line)).toEqual([2])
    expect(kept.map((h) => h.reason)).not.toContain("absolute home path")
  })

  it("a bare RegExp[] is still accepted and treated as secret (backward compatible)", () => {
    expect(screenText("two-factor", "f", [/two-factor/i], [], true)).toHaveLength(1)
  })
})

describe("upstream-owned exemption (forks)", () => {
  async function initRepo(): Promise<string> {
    const { execFile } = await import("node:child_process")
    const { promisify } = await import("node:util")
    const pexec = promisify(execFile)
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "etymd-upstream-"))
    const run = (args: string[]) => pexec("git", args, { cwd: dir })
    await run(["init", "-q"])
    await run(["config", "user.email", "t@example.com"])
    await run(["config", "user.name", "t"])
    await run(["commit", "-q", "--allow-empty", "-m", "init"])
    return dir
  }

  it("collects upstream blobs and decides ownership by content, across paths; fails closed", async () => {
    const { execFile } = await import("node:child_process")
    const { promisify } = await import("node:util")
    const pexec = promisify(execFile)
    const dir = await initRepo()
    const run = (args: string[]) => pexec("git", args, { cwd: dir })
    const out = (args: string[]) => run(args).then((r) => r.stdout.trim())

    // An upstream commit carrying doc.md, then pointed at by a remote-tracking ref.
    await fs.writeFile(path.join(dir, "doc.md"), "upstream text with two-factor wording\n")
    await run(["add", "doc.md"])
    await run(["commit", "-q", "-m", "upstream doc"])
    const upstreamSha = await out(["rev-parse", "HEAD:doc.md"])
    await run(["update-ref", "refs/remotes/upstream/main", "HEAD"])
    await run(["reset", "-q", "--soft", "HEAD~1"]) // doc.md now staged, byte-identical to upstream

    const blobs = await collectUpstreamBlobs(dir, "upstream")
    expect(blobs).not.toBeNull()
    expect(blobs!.has(upstreamSha)).toBe(true)

    // A verbatim copy at a DIFFERENT path is still upstream-owned (blob identity, not path).
    await fs.writeFile(path.join(dir, "copied.md"), "upstream text with two-factor wording\n")
    await run(["add", "copied.md"])
    // A modified upstream file is NOT owned — a fork edit must be screened fully.
    await fs.writeFile(
      path.join(dir, "mine.md"),
      "upstream text with two-factor wording + my edit\n",
    )
    await run(["add", "mine.md"])

    const staged = await stagedBlobShas(dir)
    const owned = (rel: string) => {
      const sha = staged.get(rel)
      return !!sha && blobs!.has(sha)
    }
    expect(owned("doc.md")).toBe(true)
    expect(owned("copied.md")).toBe(true)
    expect(owned("mine.md")).toBe(false)

    // Fail closed: an unknown remote yields null so the caller exempts nothing.
    expect(await collectUpstreamBlobs(dir, "no-such-remote")).toBeNull()
  })
})

describe("upstream exemption end to end (run, config-resolved)", () => {
  it("exempts a vocabulary word in an upstream-owned staged file, blocks it once modified", async () => {
    const { execFile } = await import("node:child_process")
    const { promisify } = await import("node:util")
    const { run } = await import("../src/commands/screen.js")
    const pexec = promisify(execFile)
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "etymd-run-"))
    const g = (args: string[]) => pexec("git", args, { cwd: dir })
    await g(["init", "-q"])
    await g(["config", "user.email", "t@example.com"])
    await g(["config", "user.name", "t"])
    await g(["commit", "-q", "--allow-empty", "-m", "init"])
    // An upstream commit carrying the doc, pointed at by a remote-tracking ref, then soft-reset so
    // the doc is STAGED byte-identical to upstream.
    await fs.writeFile(path.join(dir, "doc.md"), "upstream text mentioning two-factor\n")
    await g(["add", "doc.md"])
    await g(["commit", "-q", "-m", "up"])
    await g(["update-ref", "refs/remotes/upstream/main", "HEAD"])
    await g(["reset", "-q", "--soft", "HEAD~1"])
    // Opt in via config, NOT the flag — proving config resolution.
    await g(["config", "etymd.upstream", "upstream"])

    const patternFile = path.join(dir, "patterns.txt")
    await fs.writeFile(patternFile, "# class: vocabulary\ntwo-factor\n")

    process.exitCode = 0
    await run({ cwd: dir, scope: "staged", patterns: patternFile })
    const exempt = process.exitCode
    process.exitCode = 0 // reset before asserting, so a failed expect cannot leak a nonzero exit
    expect(exempt).toBe(0) // doc.md is upstream-owned → the vocabulary hit is skipped → clean

    // A fork edit to the upstream file must be screened fully.
    await fs.writeFile(path.join(dir, "doc.md"), "upstream text mentioning two-factor + my edit\n")
    await g(["add", "doc.md"])
    process.exitCode = 0
    await run({ cwd: dir, scope: "staged", patterns: patternFile })
    const blocked = process.exitCode
    process.exitCode = 0
    expect(blocked).toBe(1) // modified → no longer upstream-owned → vocabulary applies → blocked
  })
})

describe("generated-data records (allow file)", () => {
  it("reads a `generated` path record with provenance, beside line-exemption records", () => {
    const { lines, generated } = compileAllow(
      [
        "pattern ^AcmeInc$",
        "reason fixture",
        "date 2026-08-15",
        "author x",
        "generated ^src/data/corpus\\.json$",
        "reason public-domain corpus, regenerated yearly",
        "date 2026-09-04",
        "author owner",
      ].join("\n"),
    )
    expect(lines).toHaveLength(1) // the pattern record keeps its own provenance…
    expect(lines[0]?.reason).toBe("fixture")
    expect(generated).toHaveLength(1) // …and never absorbs the generated record's
    // Compared against a reference RegExp built the same way: V8 canonicalizes `/` inside
    // `.source`, and spelling the canonical form by hand just re-guesses it.
    expect(generated[0]?.path.source).toBe(new RegExp("^src/data/corpus\\.json$", "i").source)
    expect(generated[0]?.reason).toBe("public-domain corpus, regenerated yearly")
    expect(generated[0]?.author).toBe("owner")
    // The declaration matches the path it names, and nothing else.
    expect(generated[0]?.path.test("src/data/corpus.json")).toBe(true)
    expect(generated[0]?.path.test("src/data/notes.md")).toBe(false)
  })

  it("a `generated` line is a path record, never a stray line-exemption pattern", () => {
    // Without its own record kind, the line would fall through to the bare-line shorthand and
    // exempt every LINE containing its text — a hole in the gate wearing a path's clothes.
    const { lines, generated } = compileAllow(
      ["generated ^src/data/corpus\\.json$", "reason r", "date 2026-09-04", "author x"].join("\n"),
    )
    expect(lines).toHaveLength(0)
    expect(generated).toHaveLength(1)
  })

  it("generatedData drops vocabulary patterns but KEEPS secret-class AND the machine-path check", () => {
    // The asymmetry with upstream-owned is deliberate and is the point: upstream bytes are proven
    // public, generated bytes are not — a generator that embeds a home path in provenance metadata
    // is exactly the quiet leak the screen exists for.
    const pats = [
      { re: /passkey/i, cls: "vocabulary" as const },
      { re: /supersecret/i, cls: "secret" as const },
    ]
    const home = `/${"Users"}/someone/x` // assembled so the source is not a literal home path
    const text = ["the universal passkey of imagination", "mentions supersecret", home].join("\n")
    expect(screenText(text, "f", pats, [], false, false)).toHaveLength(3)
    const kept = screenText(text, "f", pats, [], false, true)
    expect(kept.map((h) => h.line)).toEqual([2, 3]) // secret-class AND machine path survive
  })
})

describe("generated-data exemption end to end (run)", () => {
  // The case the feature exists for: a regenerated public-domain corpus whose period English
  // trips credential vocabulary on a schedule, training `--no-verify` on a security hook.
  const corpusLine = "With the universal passkey of imagination we open the dingy door"

  async function initStagedRepo(): Promise<{
    dir: string
    stage: (rel: string, text: string) => Promise<void>
    patterns: string
  }> {
    const { execFile } = await import("node:child_process")
    const { promisify } = await import("node:util")
    const pexec = promisify(execFile)
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "etymd-gen-"))
    const g = (args: string[]) => pexec("git", args, { cwd: dir })
    await g(["init", "-q"])
    await g(["config", "user.email", "t@example.com"])
    await g(["config", "user.name", "t"])
    await g(["commit", "-q", "--allow-empty", "-m", "init"])
    const stage = async (rel: string, text: string) => {
      await fs.mkdir(path.join(dir, path.dirname(rel)), { recursive: true })
      await fs.writeFile(path.join(dir, rel), text)
      await g(["add", rel])
    }
    const patterns = path.join(dir, "patterns.txt")
    await fs.writeFile(patterns, "# class: vocabulary\npasskey\n")
    return { dir, stage, patterns }
  }

  it("exempts the declared path, still blocks the same word elsewhere and real secrets inside it", async () => {
    const { run } = await import("../src/commands/screen.js")
    const { dir, stage, patterns } = await initStagedRepo()
    await stage(
      ".etymd-screen-allow",
      [
        "generated ^src/data/corpus\\.json$",
        "reason public-domain corpus, regenerated yearly",
        "date 2026-09-04",
        "author owner",
      ].join("\n"),
    )
    await stage("src/data/corpus.json", `${corpusLine}\n`)
    await stage("src/data/notes.md", `${corpusLine}\n`)

    process.exitCode = 0
    await run({ cwd: dir, scope: "staged", patterns })
    const first = process.exitCode
    process.exitCode = 0
    // notes.md carries the same word but is not declared generated — it blocks, proving the
    // exemption reached only the declared path.
    expect(first).toBe(1)

    // A secret-class pattern inside the exempted file still blocks — the exemption is exactly as
    // wide as the words a natural-language corpus cannot help containing.
    const secretPatterns = path.join(dir, "secret.txt")
    await fs.writeFile(secretPatterns, "supersecret-token\n")
    process.exitCode = 0
    await stage("src/data/corpus.json", `${corpusLine}\nsupersecret-token\n`)
    await run({ cwd: dir, scope: "staged", patterns: secretPatterns })
    const second = process.exitCode
    process.exitCode = 0
    expect(second).toBe(1)
  })

  it("a generated record without provenance does not apply — the path is screened in full", async () => {
    const { run } = await import("../src/commands/screen.js")
    const { dir, stage, patterns } = await initStagedRepo()
    await stage(".etymd-screen-allow", "generated ^src/data/corpus\\.json$\n")
    await stage("src/data/corpus.json", `${corpusLine}\n`)
    process.exitCode = 0
    await run({ cwd: dir, scope: "staged", patterns })
    const blocked = process.exitCode
    process.exitCode = 0
    expect(blocked).toBe(1) // unsigned hole in the gate → refused, vocabulary applies
  })
})
