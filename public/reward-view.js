import { isRewardLink } from './reward.js';
import { renderRewardQr } from './reward-qr.js';

export function createRewardView({ qr, hint, link, value, fallback }, {
  renderQr = renderRewardQr,
  openWindow,
  onOpen = () => {},
} = {}) {
  let destination = '';
  function clear() {
    destination = '';
    qr.replaceChildren();
    qr.hidden = true;
    hint.hidden = true;
    link.textContent = '';
    link.hidden = true;
    value.textContent = '';
    value.hidden = true;
    fallback.hidden = true;
  }
  return {
    clear,
    render(reward) {
      clear();
      if (!reward || typeof reward.value !== 'string' || !reward.value || reward.value.length > 2048) return false;
      if (reward.kind === 'link') {
        if (!isRewardLink(reward.value)) return false;
        destination = reward.value;
        link.textContent = destination;
        link.hidden = false;
        let rendered = false;
        try { rendered = renderQr(qr, destination); } catch { qr.replaceChildren(); qr.hidden = true; }
        hint.hidden = !rendered;
        fallback.hidden = rendered;
      } else if (reward.kind === 'code') {
        value.textContent = reward.value;
        value.hidden = false;
      } else return false;
      return true;
    },
    open() {
      if (!destination) return false;
      openWindow(destination, '_blank', 'noopener,noreferrer');
      onOpen();
      return true;
    },
  };
}
