import { describe, expect, it } from 'vitest'
import { NO_WORLD_DATA_CODE, noWorldDataError, uploadableWorld } from './saved-variables'

const file = (body: string): Buffer => Buffer.from(`EverlookDB = {\r\n${body}\r\n}\r\n`, 'latin1')
const upload = (contents: Buffer): string | null => uploadableWorld(contents)?.toString('latin1') ?? null

const segmented = (extra = ''): string => [
  '["raw"] = { ["npcs"] = { [1] = { ["name"] = "Brace } and { in a name\\r\\n", ["world"] = "decoy", ["signature"] = "00", ["manifest"] = "decoy" } } },',
  '["secret"] = "top-secret-token",',
  '["minimap"] = { ["angle"] = 160 },',
  '["segments"] = { ["npcs.0.0"] = "2c.AAAA", ["drops.0.0"] = "2r.BBBB" },',
  '["manifest"] = "2;1;b;l;1;v;npcs.0.0=1:' + 'a'.repeat(64) + '",',
  '["signer"] = "0123456789abcdef",',
  '["signature"] = "feed",',
  extra
].join('\r\n')

describe('uploadableWorld', () => {
  it('keeps the segments, manifest, signer and signature, and nothing else', () => {
    const sent = upload(file(segmented()))
    expect(sent).toBe([
      'EverlookDB = {',
      '["segments"] = { ["npcs.0.0"] = "2c.AAAA", ["drops.0.0"] = "2r.BBBB" },',
      '["manifest"] = "2;1;b;l;1;v;npcs.0.0=1:' + 'a'.repeat(64) + '",',
      '["signer"] = "0123456789abcdef",',
      '["signature"] = "feed",',
      '}',
      ''
    ].join('\r\n'))
    expect(sent).not.toContain('top-secret-token')
    expect(sent).not.toContain('decoy')
    expect(sent).not.toContain('minimap')
  })

  it('takes a key from where its table sits, not from inside the collected rows', () => {
    const sent = upload(file('["raw"] = { [1] = { ["manifest"] = "inner", ["segments"] = { } } },\r\n["world"] = "1c.real",'))
    expect(sent).toBe('EverlookDB = {\r\n["world"] = "1c.real",\r\n}\r\n')
  })

  it('is not moved by a brace, a quote or an escape inside a string', () => {
    const tricky = '["raw"] = { [1] = "} { \\" \\\\", [2] = "\\\\" },\r\n["world"] = "1c.after",'
    expect(upload(file(tricky))).toBe('EverlookDB = {\r\n["world"] = "1c.after",\r\n}\r\n')
  })

  it('copies bytes exactly, including ones that are not ASCII', () => {
    const contents = Buffer.concat([
      Buffer.from('EverlookDB = {\r\n["world"] = "1c.', 'latin1'),
      Buffer.from([0xc3, 0xa9, 0xff, 0x00, 0x7f]),
      Buffer.from('",\r\n}\r\n', 'latin1')
    ])
    expect(uploadableWorld(contents)?.equals(contents)).toBe(true)
  })

  it('sends the same bytes however much the rest of the file changes', () => {
    const before = uploadableWorld(file(segmented('["raw2"] = { }')))
    const after = uploadableWorld(file(segmented('["raw2"] = { [1] = 2 }, ["minimapAngle"] = 12,')))
    expect(before?.equals(after ?? Buffer.alloc(0))).toBe(true)
  })

  it('reads a manifest with no segments, which is a world with nothing in it yet', () => {
    expect(upload(file('["manifest"] = "2;1;b;l;1;v;",'))).toContain('["manifest"]')
  })

  it('has nothing to send when the file holds no world', () => {
    expect(uploadableWorld(file('["minimap"] = { ["angle"] = 1 }, ["secret"] = "x",'))).toBeNull()
    expect(uploadableWorld(file('["raw"] = { }, ["segments"] = { },'))).toBeNull()
    expect(uploadableWorld(Buffer.from('EverlookDB = {}'))).toBeNull()
    expect(uploadableWorld(Buffer.from(''))).toBeNull()
  })

  it('never falls back to the whole file when it cannot follow it', () => {
    expect(uploadableWorld(Buffer.from('EverlookDB = { ["secret"] = "x", ["world"] = "1c.a'))).toBeNull()
    expect(uploadableWorld(Buffer.from('EverlookDB = { ["secret"] = "x", ["raw"] = { [1] = { ["world"] = "1c.a" }'))).toBeNull()
    expect(uploadableWorld(Buffer.from('not lua at all'))).toBeNull()
  })

  it('handles numeric keys, bare values and LF line endings', () => {
    const contents = Buffer.from('EverlookDB = {\n[3] = { { 1, 2 }, "x" },\n["flag"] = true,\n["n"] = -1.5,\n["world"] = "1c.z"\n}\n')
    expect(upload(contents)).toBe('EverlookDB = {\r\n["world"] = "1c.z",\r\n}\r\n')
  })

  it('reads a large file quickly', () => {
    const rows = Array.from({ length: 60000 }, (_, id) => `[${id}] = { ["id"] = ${id}, ["name"] = "Creature ${id}", ["locations"] = { { ["x"] = 1 } } },`).join('\n')
    const contents = file(`["raw"] = { ["npcs"] = {\n${rows}\n} },\r\n["world"] = "1c.big",`)
    expect(contents.byteLength).toBeGreaterThan(4_000_000)
    const started = performance.now()
    expect(upload(contents)).toBe('EverlookDB = {\r\n["world"] = "1c.big",\r\n}\r\n')
    expect(performance.now() - started).toBeLessThan(1500)
  })
})

describe('noWorldDataError', () => {
  it('carries a code the recovery queue recognises', () => {
    expect((noWorldDataError() as Error & { code: string }).code).toBe(NO_WORLD_DATA_CODE)
  })
})
