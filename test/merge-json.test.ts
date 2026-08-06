import { describe, expect, it } from "vitest"

import { mergeScriptInto } from "../src/core/merge-json.js"

const PKG = `{
  "name": "demo",
  "version": "1.0.0",
  "scripts": {
    "build": "tsc",
    "test": "vitest"
  },
  "dependencies": {
    "left": "^1.0.0"
  }
}
`

describe("package.json script merge", () => {
  it("adds the key and leaves every other key and its order untouched", () => {
    const { text, result } = mergeScriptInto(PKG, "prepublishOnly", "./scripts/artifact-check.sh")
    expect(result.outcome).toBe("added")
    const doc = JSON.parse(text as string) as {
      scripts: Record<string, string>
      dependencies: Record<string, string>
    }
    expect(doc.scripts.prepublishOnly).toBe("./scripts/artifact-check.sh")
    // Everything the user owns survives, in the order they wrote it.
    expect(Object.keys(doc)).toEqual(["name", "version", "scripts", "dependencies"])
    expect(doc.scripts.build).toBe("tsc")
    expect(doc.scripts.test).toBe("vitest")
    expect(doc.dependencies.left).toBe("^1.0.0")
  })

  it("PINNED: refuses to overwrite a different existing value", () => {
    // The user's own publish hook must never be silently replaced — doing so could disable a
    // check they depend on at the one moment that is irreversible.
    const pkg = PKG.replace('"test": "vitest"', '"test": "vitest",\n    "prepublishOnly": "mine"')
    const { text, result } = mergeScriptInto(pkg, "prepublishOnly", "./scripts/artifact-check.sh")
    expect(result.outcome).toBe("conflict")
    expect(result.existing).toBe("mine")
    expect(text).toBeUndefined()
  })

  it("is idempotent — an identical value is a no-op, not a rewrite", () => {
    const once = mergeScriptInto(PKG, "prepublishOnly", "x").text as string
    const twice = mergeScriptInto(once, "prepublishOnly", "x")
    expect(twice.result.outcome).toBe("unchanged")
    expect(twice.text).toBeUndefined()
  })

  it("preserves the file's own indentation and trailing newline", () => {
    const tabbed = '{\n\t"name": "demo"\n}\n'
    const { text } = mergeScriptInto(tabbed, "prepublishOnly", "x")
    expect(text).toContain('\t"name"')
    expect(text?.endsWith("\n")).toBe(true)

    const noTrailing = '{\n  "name": "demo"\n}'
    expect(mergeScriptInto(noTrailing, "k", "v").text?.endsWith("}")).toBe(true)
  })

  it("adds a scripts block when the manifest has none", () => {
    const { text, result } = mergeScriptInto('{\n  "name": "demo"\n}\n', "prepublishOnly", "x")
    expect(result.outcome).toBe("added")
    expect(JSON.parse(text as string).scripts).toEqual({ prepublishOnly: "x" })
  })

  it("reports an unparsable manifest instead of destroying it", () => {
    const { text, result } = mergeScriptInto("{ not json", "k", "v")
    expect(result.outcome).toBe("unparsable")
    expect(text).toBeUndefined()
  })
})
