/*
  MARS // JARVIS — CONFIG
  ------------------------------------------------------------
  There is no backend in this project, so Jarvis talks to Google
  Drive directly from the browser using YOUR OWN Google Cloud
  OAuth Client ID. Follow the setup steps in README.md, then
  paste your Client ID below.

  You do NOT need an API key for this build — only an OAuth
  Client ID (Drive access happens over an authorized token).
*/

const JARVIS_CONFIG = {
  GOOGLE_CLIENT_ID: "863424620371-ljo7ckelfnq8gq7tlbplemmblr1glosr.apps.googleusercontent.com",

  // Drive scope: drive.file only touches files this app creates —
  // Jarvis never sees the rest of your Drive.
  DRIVE_SCOPE: "https://www.googleapis.com/auth/drive.file",

  // Filename for the single persistent memory file.
  DATA_FILENAME: "jarvis-data.json",

  // Wake word Jarvis listens for during continuous listening.
  WAKE_WORD: "jarvis"
};
