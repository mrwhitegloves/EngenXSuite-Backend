// Settings of the meeting recorder (the Chrome extension) and of meeting transcripts.
// Founder decisions 2026-11-14: everyone may record; Hindi is written in Roman letters;
// the audio is kept 60 days, the text for ever.

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export const TRANSCRIPT_SETTINGS = {
  // How long the audio of a piece stays in storage. The text stays.
  audioKeepMs: 60 * DAY_MS,
  // One piece of speech, as the extension cuts it at a pause.
  maxSegmentBytes: 2 * 1024 * 1024,
  maxSegmentMs: 60 * 1000,
  // A recording that sent nothing for this long is taken as stopped (the laptop slept, the
  // browser closed) and its transcript is finished.
  idleStopMs: 15 * MINUTE_MS,
  // Pieces after this much time in one recording are refused (a recorder left running).
  maxRecordingMs: 4 * 60 * MINUTE_MS,
  // A piece still waiting this long is queued again by the sweep.
  pendingRetryMs: 2 * MINUTE_MS,
  // A piece the AI could not read after this many tries stays without text ("failed").
  maxAttempts: 3,
  // The laptop's clock may be this far off ours; a piece further off is placed by our clock.
  maxClockSkewMs: 10 * MINUTE_MS,
};

export const RECORDER_SETTINGS = {
  // A code shown in the CRM and typed into the extension once.
  pairingCodeMs: 10 * MINUTE_MS,
  pairingCodeLength: 8,
  // A connected extension stays connected while it is used at least this often.
  deviceIdleMs: 90 * DAY_MS,
  maxDevicesPerUser: 5,
};

// What the extension sends: "mic" is the voice of the person recording (our side),
// "tab" is the sound of the Meet tab (everyone else in the meeting).
export const TRANSCRIPT_TRACKS = ['mic', 'tab'];
