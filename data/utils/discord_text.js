const DISCORD_MAX = 2000;

// "-# " is Discord's small-text markdown.
const modelLabel = (model) => `-# answered by ${model}`;

// Splits text into pieces of at most `max` characters and puts the label (on
// its own line) at the end of the last piece. If the label doesn't fit on the
// last piece, it becomes a piece of its own.
function splitWithLabel(text, label, max = DISCORD_MAX) {
  const pieces = [];
  for (let i = 0; i < text.length; i += max) pieces.push(text.slice(i, i + max));
  if (!pieces.length) pieces.push("");
  if (!label) return pieces;

  const last = pieces.length - 1;
  const withLabel = `${pieces[last]}\n${label}`;
  if (withLabel.length <= max) pieces[last] = withLabel;
  else pieces.push(`\n${label}`);
  return pieces;
}

module.exports = { splitWithLabel, modelLabel };
