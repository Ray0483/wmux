import qrcode from 'qrcode-generator';

/**
 * The pairing QR for the Remote Console (#254), as an SVG string.
 *
 * Pure, so the one part of the pairing dialog that has to be exactly right is
 * testable without a DOM. The caller renders it as
 * `<img src={'data:image/svg+xml;utf8,' + encodeURIComponent(svg)}>` and NEVER
 * through innerHTML: the text encoded here is a URL whose base comes from a
 * user-typed Public URL, and an `<img>` cannot run anything an SVG carries —
 * innerHTML would make the escaping below the only thing between that text and
 * the settings window.
 *
 * The SVG is drawn from `isDark` rather than taken from the library's
 * `createSvgTag`: that tag paints no background, so on a dark theme the quiet
 * zone is transparent and a phone camera cannot find the finder patterns
 * against a black settings window. An explicit white square behind black
 * modules scans on every theme, and the markup no longer depends on the
 * library's formatting across a version bump.
 *
 * Type 0 lets the library pick the smallest version that fits; level 'M'
 * (15% recovery) is the usual trade for a code shown on a screen, where
 * damage is glare rather than a torn sticker, and it keeps a 120-character
 * pairing URL at a size a phone resolves from arm's length.
 */

/** Quiet zone, in modules. The QR spec asks for 4; fewer and readers miss it. */
const QUIET_ZONE = 4;

export function qrSvg(text: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();

  const count = qr.getModuleCount();
  const size = count + QUIET_ZONE * 2;
  // One path, one `M x y h1 v1 h-1 z` per dark module: coordinates in module
  // units, scaled by the viewBox, so the image stays crisp at any CSS size.
  const cells: string[] = [];
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) cells.push(`M${col + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`);
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="#fff"/>` +
    `<path d="${cells.join('')}" fill="#000"/>` +
    `</svg>`
  );
}

/** The `<img src>` for `qrSvg(text)`. */
export function qrDataUri(text: string): string {
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(qrSvg(text));
}
