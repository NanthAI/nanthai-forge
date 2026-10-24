// SPDX-License-Identifier: Apache-2.0
// Byte-preserving: artifacts need not be UTF-8. Only matched bytes are replaced.
type Rule = { from: Buffer; to: Buffer; mask?: boolean; boundary?: boolean };
const boundary = (byte: number) => byte <= 32 || [34, 39, 40, 61, 58, 91, 123].includes(byte);
const delimiter = (byte: number) => byte <= 32 || [34, 39, 44, 59, 41, 62].includes(byte);
/** Trusted code supplies actual credentials and private workspace/home roots.
 * Literal prefixes survive byte boundaries. Common credential syntax and other
 * absolute paths are masked without retaining an arbitrarily long token. No
 * heuristic can discover every encoded/unknown credential; keys never belong in
 * project-code processes merely because collection applies redaction. */
export class HostedOutputRedactor {
  private pending = Buffer.alloc(0);
  private atBoundary = true;
  private mask: { quote: number | null; first: boolean } | null = null;
  private readonly rules: Rule[];
  constructor(input: { secrets: readonly string[]; paths: readonly string[] }) {
    this.rules = [
      ...input.secrets
        .filter(Boolean)
        .map(from => ({ from: Buffer.from(from), to: Buffer.from('[redacted]') })),
      ...input.paths
        .filter(Boolean)
        .map(from => ({ from: Buffer.from(from), to: Buffer.from('[workspace]') })),
      ...[
        'Bearer ',
        'bearer ',
        'Basic ',
        'token=',
        'password=',
        'secret=',
        'api_key=',
        'apiKey=',
        'authorization=',
        'ghp_',
        'gho_',
        'github_pat_',
        'sk-',
      ].map(from => ({
        from: Buffer.from(from),
        to: Buffer.from('[redacted]'),
        mask: true,
        boundary: ['Bearer ', 'bearer ', 'Basic ', 'ghp_', 'gho_', 'github_pat_', 'sk-'].includes(from),
      })),
      ...['/', '~/', 'file://'].map(from => ({
        from: Buffer.from(from),
        to: Buffer.from('[path]'),
        mask: true,
        boundary: true,
      })),
    ].sort((a, b) => b.from.length - a.from.length);
  }
  write(bytes: Uint8Array, final = false): Buffer {
    const source = Buffer.concat([this.pending, bytes]);
    const parts: Buffer[] = [];
    let start = 0,
      offset = 0;
    while (offset < source.length) {
      const byte = source[offset]!;
      if (this.mask) {
        if (offset > start) parts.push(source.subarray(start, offset));
        if (this.mask.first && [34, 39].includes(byte)) {
          this.mask = { first: false, quote: byte };
        } else if (this.mask.quote === byte) {
          this.mask = null;
        } else if (this.mask.quote === null && delimiter(byte)) {
          this.mask = null;
          start = offset;
          continue;
        } else this.mask.first = false;
        offset++;
        start = offset;
        this.atBoundary = false;
        continue;
      }
      const tail = source.subarray(offset);
      const rules = this.rules.filter(r => !r.boundary || this.atBoundary);
      // Wait for a longer rule even if a shorter rule could already match.
      if (
        !final &&
        rules.some(r => tail.length < r.from.length && r.from.subarray(0, tail.length).equals(tail))
      )
        break;
      // Windows absolute paths are detected without enumerating drive letters.
      const windows = this.atBoundary && /^[A-Za-z]:[\\/]/.test(tail.subarray(0, 3).toString('latin1'));
      if (!final && this.atBoundary && /^[A-Za-z]:?$/.test(tail.toString('latin1'))) break;
      const rule = rules.find(
        r => tail.length >= r.from.length && tail.subarray(0, r.from.length).equals(r.from),
      );
      if (rule || windows) {
        parts.push(source.subarray(start, offset), rule?.to ?? Buffer.from('[path]'));
        offset += rule?.from.length ?? 3;
        start = offset;
        this.atBoundary = false;
        if (rule ? rule.mask : windows) this.mask = { quote: null, first: true };
      } else {
        this.atBoundary = boundary(byte);
        offset++;
      }
    }
    parts.push(source.subarray(start, offset));
    this.pending = Buffer.from(source.subarray(offset));
    return Buffer.concat(parts);
  }
  end() {
    return this.write(new Uint8Array(), true);
  }
}
