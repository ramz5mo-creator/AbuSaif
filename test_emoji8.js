// Test different forms of emoji 8
const forms = [
  '8\u20E3',        // 38 + 20E3 (no variation selector)
  '8\uFE0F\u20E3',  // 38 + FE0F + 20E3 (with variation selector)
  '5\u20E3',        // 5 for comparison
  '3\uFE0F\u20E3',  // 3 for comparison
  '\uD83D\uDD1F',   // 🔟
];

// Copy of parser functions
function emojiToNumber(text) {
  if (!text) return null;
  const t = text.trim();
  if (t === '\uD83D\uDC4D') return 1; // 👍
  if (t === '\uD83D\uDD1F') return 10; // 🔟
  const textWithoutTen = t.replace(/\uD83D\uDD1F/g, '10');
  const keycapRegex2 = /([0-9])\uFE0F?\u20E3/g;
  let result2 = '';
  let m;
  while ((m = keycapRegex2.exec(textWithoutTen)) !== null) {
    result2 += m[1];
  }
  if (!result2) {
    const numMatch = textWithoutTen.match(/^(\d+)$/);
    if (numMatch) result2 = numMatch[1];
  }
  if (result2) {
    const n = parseInt(result2, 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return null;
}

function isQuantityEmoji(text) {
  if (!text) return false;
  const t = text.trim();
  if (t === '\uD83D\uDC4D') return true; // 👍
  if (t === '\uD83D\uDD1F') return true; // 🔟
  const hasKeycapEmoji = /[\u0030-\u0039]\uFE0F?\u20E3/.test(t);
  if (!hasKeycapEmoji) return false;
  const converted = emojiToNumber(t);
  return converted !== null && converted > 0;
}

for (const f of forms) {
  const codePoints = [...f].map(c => c.codePointAt(0).toString(16).toUpperCase());
  console.log('Form:', JSON.stringify(f), '| CodePoints:', codePoints.join('+'), '| isQty:', isQuantityEmoji(f), '| num:', emojiToNumber(f));
}
