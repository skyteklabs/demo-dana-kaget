import { isRewardLink } from './reward.js';
import { QrCode, QrSegment } from './vendor/qr/qrcodegen.js';

const QUIET_ZONE = 4;
const MAX_VERSION = 12;
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

export function createRewardQr(value) {
  if (typeof value !== 'string' || value.length > 2048 || !isRewardLink(value)) return null;
  try {
    const segments = QrSegment.makeSegments(value);
    if (/[^\x00-\x7f]/.test(value)) segments.unshift(QrSegment.makeEci(26));
    // Larger symbols become difficult to scan on a phone; the link remains usable.
    const qr = QrCode.encodeSegments(segments, QrCode.Ecc.MEDIUM, 1, MAX_VERSION);
    return {
      size: qr.size,
      quietZone: QUIET_ZONE,
      modules: Array.from({ length: qr.size }, (_, y) =>
        Array.from({ length: qr.size }, (_, x) => qr.getModule(x, y))),
    };
  } catch {
    return null;
  }
}

export function renderRewardQr(container, value) {
  container.replaceChildren();
  container.hidden = true;
  const qr = createRewardQr(value);
  if (!qr) return false;

  const document = container.ownerDocument;
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  const extent = qr.size + qr.quietZone * 2;
  svg.setAttribute('viewBox', `0 0 ${extent} ${extent}`);
  svg.setAttribute('width', '256');
  svg.setAttribute('height', '256');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Kode QR untuk membuka tautan DANA');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('shape-rendering', 'crispEdges');

  const background = document.createElementNS(SVG_NAMESPACE, 'rect');
  background.setAttribute('width', String(extent));
  background.setAttribute('height', String(extent));
  background.setAttribute('fill', '#fff');

  const path = document.createElementNS(SVG_NAMESPACE, 'path');
  const runs = [];
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (!qr.modules[y][x]) continue;
      const start = x;
      while (x + 1 < qr.size && qr.modules[y][x + 1]) x++;
      const width = x - start + 1;
      runs.push(`M${start + qr.quietZone},${y + qr.quietZone}h${width}v1h-${width}z`);
    }
  }
  path.setAttribute('d', runs.join(''));
  path.setAttribute('fill', '#000');
  svg.append(background, path);
  container.replaceChildren(svg);
  container.hidden = false;
  return true;
}
