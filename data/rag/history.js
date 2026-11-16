// Per-user AI conversation history, tagged with where each line was said.
// Without this, an answer that quoted #mod-chat memory would be replayed to
// the model when the same user asks in #general — and repeated there.

const historyEntry = (role, content, { channelId, pub }) => ({ role, content, channelId, pub });

// Entries from this channel, or from channels everyone could see. Entries saved
// before tagging existed (no channelId) are kept; they expire within 7 days.
function visibleHistory(entries, channelId) {
  return entries
    .filter(e => e.channelId == null || e.channelId === channelId || e.pub === true)
    .map(({ role, content }) => ({ role, content }));
}

module.exports = { historyEntry, visibleHistory };
