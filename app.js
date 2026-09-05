/* ==========================================================
   MARS // JARVIS — Phase I application logic
   No framework, no backend. Google Drive is the only database.
   ========================================================== */

(function () {
  "use strict";

  /* ---------------------------------------------------------
     STATE
     --------------------------------------------------------- */
  const state = {
    isSignedIn: false,
    accessToken: null,
    tokenClient: null,
    fileId: null,
    saveTimer: null,
    isListening: false,      // continuous mode on/off
    isAwake: false,          // wake word triggered, awaiting command
    isMuted: false,
    isPushToTalk: false,
    recognition: null,
    awakeTimeout: null,
    data: {
      notes: [],
      tasks: [],
      research: [],
      settings: { voiceURI: null, continuousListening: false },
      conversations: []
    }
  };

  const $ = (sel) => document.querySelector(sel);
  const $all = (sel) => Array.from(document.querySelectorAll(sel));

  /* ---------------------------------------------------------
     TOAST + ACTIVITY LOG
     --------------------------------------------------------- */
  let toastTimer = null;
  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
  }

  function timeNow() {
    return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function logActivity(text) {
    const feed = $("#activityFeed");
    const empty = feed.querySelector(".activity-empty");
    if (empty) empty.remove();
    const li = document.createElement("li");
    li.innerHTML = `${escapeHtml(text)}<time>${timeNow()}</time>`;
    feed.prepend(li);
    while (feed.children.length > 25) feed.removeChild(feed.lastChild);
  }

  function logCommand(text, kind) {
    const list = $("#commandHistory");
    const empty = list.querySelector(".activity-empty");
    if (empty) empty.remove();
    const li = document.createElement("li");
    li.style.borderLeftColor = kind === "user" ? "var(--accent)" : "var(--accent-warm)";
    li.innerHTML = `${escapeHtml(text)}<time>${timeNow()}</time>`;
    list.prepend(li);
    while (list.children.length > 40) list.removeChild(list.lastChild);
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  /* ---------------------------------------------------------
     NAVIGATION
     --------------------------------------------------------- */
  function initNav() {
    $all(".nav-item").forEach((item) => {
      item.addEventListener("click", () => {
        $all(".nav-item").forEach((i) => i.classList.remove("active"));
        item.classList.add("active");
        const section = item.dataset.section;
        $all(".view").forEach((v) => v.classList.remove("active"));
        $(`#view-${section}`).classList.add("active");
        $("#sidebar").classList.remove("open");
      });
    });

    $("#hamburgerBtn").addEventListener("click", () => {
      $("#sidebar").classList.toggle("open");
    });
  }

  function initClock() {
    const el = $("#homeDate");
    function tick() {
      const d = new Date();
      el.textContent = d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" }) +
        " — " + d.toLocaleTimeString();
    }
    tick();
    setInterval(tick, 1000);
  }

  /* ---------------------------------------------------------
     GOOGLE AUTH (Google Identity Services — token model)
     --------------------------------------------------------- */
  function initGoogleAuth() {
    if (typeof google === "undefined" || !google.accounts) {
      // GIS script may not have loaded yet; retry shortly.
      setTimeout(initGoogleAuth, 400);
      return;
    }
    if (JARVIS_CONFIG.GOOGLE_CLIENT_ID.startsWith("PASTE_YOUR")) {
      $("#accountDesc").textContent =
        "No Google Client ID configured yet. Add yours in config.js to enable Drive sync.";
      return;
    }

    state.tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: JARVIS_CONFIG.GOOGLE_CLIENT_ID,
      scope: JARVIS_CONFIG.DRIVE_SCOPE,
      callback: async (resp) => {
        if (resp.error) {
          toast("Sign-in failed: " + resp.error);
          return;
        }
        state.accessToken = resp.access_token;
        state.isSignedIn = true;
        updateAuthUI();
        await loadMemoryFromDrive();
        logActivity("Connected to Google Drive.");
        speak("Google Drive connected. Memory synchronized.");
      }
    });
  }

  function signIn() {
    if (!state.tokenClient) {
      toast("Google auth not ready — check your Client ID in config.js");
      return;
    }
    state.tokenClient.requestAccessToken({ prompt: "consent" });
  }

  function signOut() {
    if (state.accessToken) {
      google.accounts.oauth2.revoke(state.accessToken, () => {});
    }
    state.accessToken = null;
    state.isSignedIn = false;
    state.fileId = null;
    updateAuthUI();
    toast("Disconnected from Google Drive.");
    logActivity("Disconnected from Google Drive.");
  }

  function updateAuthUI() {
    const dot = $("#driveStatusDot");
    const text = $("#driveStatusText");
    if (state.isSignedIn) {
      dot.classList.add("on");
      text.textContent = "Drive: connected";
      $("#accountDesc").textContent = "Connected. Notes, tasks, and conversation history sync to jarvis-data.json.";
      $("#signInBtn").style.display = "none";
      $("#signOutBtn").style.display = "inline-block";
      $("#statSync").textContent = "SYNCED";
    } else {
      dot.classList.remove("on");
      text.textContent = "Drive: disconnected";
      $("#signInBtn").style.display = "inline-block";
      $("#signOutBtn").style.display = "none";
      $("#statSync").textContent = "LOCAL";
    }
  }

  /* ---------------------------------------------------------
     DRIVE PERSISTENCE
     jarvis-data.json lives in the app-data folder (drive.file scope,
     appDataFolder space) — invisible clutter-free storage tied only
     to this app.
     --------------------------------------------------------- */
  const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
  const DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";

  function authHeaders() {
    return { Authorization: "Bearer " + state.accessToken };
  }

  async function findDataFile() {
    const q = encodeURIComponent(`name='${JARVIS_CONFIG.DATA_FILENAME}' and trashed=false`);
    const url = `${DRIVE_FILES_URL}?q=${q}&spaces=appDataFolder&fields=files(id,name)`;
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) throw new Error("Drive lookup failed: " + res.status);
    const json = await res.json();
    return json.files && json.files.length ? json.files[0].id : null;
  }

  async function createDataFile() {
    const metadata = {
      name: JARVIS_CONFIG.DATA_FILENAME,
      parents: ["appDataFolder"]
    };
    const boundary = "jarvis_boundary_" + Date.now();
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify(metadata) +
      `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n` +
      JSON.stringify(state.data) +
      `\r\n--${boundary}--`;

    const res = await fetch(`${DRIVE_UPLOAD_URL}?uploadType=multipart&fields=id`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": `multipart/related; boundary=${boundary}` },
      body
    });
    if (!res.ok) throw new Error("Drive create failed: " + res.status);
    const json = await res.json();
    return json.id;
  }

  async function loadMemoryFromDrive() {
    try {
      let id = await findDataFile();
      if (!id) {
        id = await createDataFile();
        toast("Created jarvis-data.json on Drive.");
      }
      state.fileId = id;
      const res = await fetch(`${DRIVE_FILES_URL}/${id}?alt=media`, { headers: authHeaders() });
      if (res.ok) {
        const remote = await res.json();
        state.data = Object.assign(
          { notes: [], tasks: [], research: [], settings: {}, conversations: [] },
          remote
        );
      }
      renderAll();
    } catch (err) {
      console.error(err);
      toast("Could not reach Google Drive.");
    }
  }

  function saveMemoryToDrive() {
    if (!state.isSignedIn || !state.fileId) return;
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(async () => {
      try {
        await fetch(`${DRIVE_UPLOAD_URL}/${state.fileId}?uploadType=media`, {
          method: "PATCH",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify(state.data)
        });
        $("#statSync").textContent = "SYNCED";
      } catch (err) {
        console.error(err);
        $("#statSync").textContent = "ERROR";
      }
    }, 600); // debounce rapid edits
  }

  function persist() {
    saveMemoryToDrive();
    renderAll();
  }

  /* ---------------------------------------------------------
     NOTES: create / edit / delete / search
     --------------------------------------------------------- */
  function createNote(title, body) {
    const note = {
      id: "n_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: title && title.trim() ? title.trim() : body.slice(0, 30) || "Untitled note",
      body: body || "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    state.data.notes.unshift(note);
    persist();
    logActivity(`Note saved: "${note.title}"`);
    return note;
  }

  function editNote(id, title, body) {
    const note = state.data.notes.find((n) => n.id === id);
    if (!note) return false;
    note.title = title;
    note.body = body;
    note.updatedAt = new Date().toISOString();
    persist();
    logActivity(`Note updated: "${note.title}"`);
    return true;
  }

  function deleteNote(id) {
    const note = state.data.notes.find((n) => n.id === id);
    state.data.notes = state.data.notes.filter((n) => n.id !== id);
    persist();
    if (note) logActivity(`Note deleted: "${note.title}"`);
  }

  function searchNotes(query) {
    const q = query.trim().toLowerCase();
    if (!q) return state.data.notes;
    return state.data.notes.filter(
      (n) => n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q)
    );
  }

  function renderNotes() {
    const grid = $("#notesGrid");
    const query = $("#noteSearch").value;
    const notes = searchNotes(query);
    $("#statNotes").textContent = state.data.notes.length;

    if (!notes.length) {
      grid.innerHTML = `<p class="empty-hint">${
        query ? "No notes match your search." : 'No notes yet. Say "Jarvis, save note..." or add one manually.'
      }</p>`;
      return;
    }

    grid.innerHTML = "";
    notes.forEach((note) => {
      const card = document.createElement("div");
      card.className = "glass-panel note-card";
      card.innerHTML = `
        <h4>${escapeHtml(note.title)}</h4>
        <p>${escapeHtml(note.body)}</p>
        <span class="note-meta">${new Date(note.updatedAt).toLocaleString()}</span>
        <div class="note-actions">
          <button class="hud-btn tiny edit-note-btn">Edit</button>
          <button class="hud-btn tiny danger-outline del-note-btn">Delete</button>
        </div>`;
      card.querySelector(".edit-note-btn").addEventListener("click", () => openNoteModal(note));
      card.querySelector(".del-note-btn").addEventListener("click", () => {
        if (confirm(`Delete note "${note.title}"?`)) deleteNote(note.id);
      });
      grid.appendChild(card);
    });
  }

  let editingNoteId = null;
  function openNoteModal(note) {
    editingNoteId = note ? note.id : null;
    $("#noteModalTitle").textContent = note ? "Edit Note" : "New Note";
    $("#noteTitleInput").value = note ? note.title : "";
    $("#noteBodyInput").value = note ? note.body : "";
    $("#noteModalOverlay").classList.add("active");
    $("#noteTitleInput").focus();
  }
  function closeNoteModal() {
    $("#noteModalOverlay").classList.remove("active");
    editingNoteId = null;
  }

  /* ---------------------------------------------------------
     TASKS: add / complete / delete / priority
     --------------------------------------------------------- */
  function addTask(text, priority) {
    const task = {
      id: "t_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      text: text.trim(),
      priority: priority || "medium",
      done: false,
      createdAt: new Date().toISOString()
    };
    state.data.tasks.unshift(task);
    persist();
    logActivity(`Task added: "${task.text}" [${task.priority}]`);
    return task;
  }

  function completeTask(id, done) {
    const t = state.data.tasks.find((x) => x.id === id);
    if (!t) return;
    t.done = done !== undefined ? done : !t.done;
    persist();
    logActivity(`Task ${t.done ? "completed" : "reopened"}: "${t.text}"`);
  }

  function deleteTask(id) {
    const t = state.data.tasks.find((x) => x.id === id);
    state.data.tasks = state.data.tasks.filter((x) => x.id !== id);
    persist();
    if (t) logActivity(`Task deleted: "${t.text}"`);
  }

  function setPriority(id, priority) {
    const t = state.data.tasks.find((x) => x.id === id);
    if (!t) return;
    t.priority = priority;
    persist();
  }

  const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
  function renderTasks() {
    const pending = state.data.tasks
      .filter((t) => !t.done)
      .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
    const completed = state.data.tasks.filter((t) => t.done);

    $("#statTasks").textContent = pending.length;

    const pendingList = $("#pendingTaskList");
    const completedList = $("#completedTaskList");
    pendingList.innerHTML = "";
    completedList.innerHTML = "";

    if (!pending.length) pendingList.innerHTML = `<li class="empty-hint">No pending tasks. Well done.</li>`;
    if (!completed.length) completedList.innerHTML = `<li class="empty-hint">Nothing completed yet.</li>`;

    pending.forEach((t) => pendingList.appendChild(buildTaskEl(t)));
    completed.forEach((t) => completedList.appendChild(buildTaskEl(t)));
  }

  function buildTaskEl(t) {
    const li = document.createElement("li");
    li.className = "task-item" + (t.done ? " done" : "");
    li.innerHTML = `
      <button class="task-check" aria-label="Toggle complete">${t.done ? "✓" : ""}</button>
      <span class="task-text">${escapeHtml(t.text)}</span>
      <span class="priority-tag ${t.priority}">${t.priority}</span>
      <button class="task-del" aria-label="Delete task">✕</button>`;
    li.querySelector(".task-check").addEventListener("click", () => completeTask(t.id));
    li.querySelector(".task-del").addEventListener("click", () => deleteTask(t.id));
    return li;
  }

  /* ---------------------------------------------------------
     RENDER ALL
     --------------------------------------------------------- */
  function renderAll() {
    renderNotes();
    renderTasks();
  }

  /* ---------------------------------------------------------
     SPEECH SYNTHESIS
     --------------------------------------------------------- */
  function populateVoices() {
    const select = $("#voiceSelect");
    const voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
    if (!voices.length) return;
    select.innerHTML = "";
    voices.forEach((v, i) => {
      const opt = document.createElement("option");
      opt.value = v.voiceURI;
      opt.textContent = `${v.name} (${v.lang})`;
      select.appendChild(opt);
    });
    if (state.data.settings.voiceURI) select.value = state.data.settings.voiceURI;
  }

  function speak(text) {
    if (state.isMuted || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    const voices = window.speechSynthesis.getVoices();
    const chosen = voices.find((v) => v.voiceURI === state.data.settings.voiceURI);
    if (chosen) utter.voice = chosen;
    utter.rate = 1.02;
    utter.pitch = 0.95;

    utter.onstart = () => setVoiceVisualState("speaking");
    utter.onend = () => setVoiceVisualState(state.isListening ? "listening" : "idle");

    window.speechSynthesis.speak(utter);
    logCommand(text, "jarvis");
  }

  function setVoiceVisualState(mode) {
    const orb = $("#micOrb");
    const label = $("#voiceStateLabel");
    const coreState = $("#coreState");
    orb.classList.remove("listening", "speaking");
    coreState.classList.remove("listening", "speaking");
    if (mode === "listening") {
      orb.classList.add("listening");
      label.textContent = "LISTENING";
      coreState.textContent = "LISTENING";
      coreState.classList.add("listening");
    } else if (mode === "speaking") {
      orb.classList.add("speaking");
      label.textContent = "SPEAKING";
      coreState.textContent = "RESPONDING";
      coreState.classList.add("speaking");
    } else if (mode === "awake") {
      orb.classList.add("listening");
      label.textContent = "AWAITING COMMAND";
      coreState.textContent = "AWAKE";
      coreState.classList.add("listening");
    } else {
      label.textContent = "IDLE";
      coreState.textContent = "SYSTEM READY";
    }
  }

  /* ---------------------------------------------------------
     SPEECH RECOGNITION + WAKE WORD + COMMAND PARSER
     --------------------------------------------------------- */
  function getRecognitionCtor() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  function initRecognition() {
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      $("#transcriptBox").textContent = "Speech recognition is not supported in this browser. Try Chrome.";
      $("#continuousToggleBtn").disabled = true;
      $("#pushToTalkBtn").disabled = true;
      return;
    }
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";

    rec.onresult = (event) => {
      let finalTranscript = "";
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalTranscript += transcript;
        else interim += transcript;
      }
      $("#transcriptBox").textContent = (finalTranscript || interim || "Listening...").trim();
      if (finalTranscript) handleHeardSpeech(finalTranscript.trim());
    };

    rec.onerror = (e) => {
      console.warn("Speech recognition error:", e.error);
      if (e.error === "not-allowed") {
        toast("Microphone permission denied.");
        stopContinuousListening();
      }
    };

    rec.onend = () => {
      // auto-restart if continuous mode is still supposed to be on
      if (state.isListening && !state.isPushToTalk) {
        try { rec.start(); } catch (e) { /* already started */ }
      }
    };

    state.recognition = rec;
  }

  function handleHeardSpeech(text) {
    const lower = text.toLowerCase();
    const wake = JARVIS_CONFIG.WAKE_WORD.toLowerCase();

    if (state.isAwake) {
      // We already got the wake word previously; treat this whole utterance as the command.
      clearTimeout(state.awakeTimeout);
      processCommand(text);
      return;
    }

    const idx = lower.indexOf(wake);
    if (idx === -1) return; // ignore ambient speech without wake word

    const after = text.slice(idx + wake.length).trim();
    if (after.length > 0) {
      processCommand(after);
    } else {
      // Wake word alone — open a short window to receive the command
      state.isAwake = true;
      setVoiceVisualState("awake");
      speak("Yes?");
      state.awakeTimeout = setTimeout
