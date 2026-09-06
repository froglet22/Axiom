/*
  AXIOM — CONFIG
  ------------------------------------------------------------
  There is no backend in this project, so Axiom talks to Google
  Drive and Google's Gemini AI directly from the browser using
  YOUR OWN keys. Follow README.md, then fill in the two values
  below.

  IMPORTANT — GEMINI_API_KEY SAFETY:
  This key will be visible to anyone who views your site's source
  code, since there is no backend to hide it behind. As long as
  you NEVER add a billing account to the Google Cloud project this
  key belongs to, it is impossible for you to be charged — Google
  will simply stop responding once the free daily quota is used up.
  Do not add billing to this project.
*/

const JARVIS_CONFIG = {
  GOOGLE_CLIENT_ID: "863424620371-ljo7ckelfnq8gq7tlbplemmblr1glosr.apps.googleusercontent.com",

  // Get a free key at https://aistudio.google.com/app/apikey
  // (uses the same Google account/project as your Drive setup)
  GEMINI_API_KEY: "PASTE_YOUR_GEMINI_API_KEY_HERE",
  GEMINI_MODEL: "gemini-2.0-flash",

  // Drive scope: drive.file only touches files this app creates —
  // Axiom never sees the rest of your Drive.
  DRIVE_SCOPE: "https://www.googleapis.com/auth/drive.file",

  // Filename for the single persistent memory file.
  DATA_FILENAME: "axiom-data.json",

  // Wake word Axiom listens for during continuous listening.
  WAKE_WORD: "axiom"
};
