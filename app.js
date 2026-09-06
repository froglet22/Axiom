/* ==========================================================
   AXIOM — Phase I+ application logic
   No framework, no backend. Google Drive is the only database.
   Gemini (optional) provides real conversational understanding.
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
    isListening: false,
    isAwake: false,
    isMuted: false,
    isPushToTalk: false,
    recognition: null,
    awakeTimeout: null,
    pendingImage: null,
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

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

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

  /* ---------------------------------------------------------
     NAVIGATION (sidebar + bottom nav share the same buttons)
     --------------------------------------------------------- */
  function switchToView(section) {
    $all(".nav-item, .bnav-item").forEach((i) => i.classList.toggle("active", i.dataset.section === section));
    $all(".view").forEach((v) => v.classList.remove("active"));
    $(`#view-${section}`).classList.add("active");
  }

  function initNav() {
    $all(".nav-item, .bnav-item").forEach((item) => {
      item.addEventListener("click", () => switchToView(item.dataset.section));
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

  function initGreeting() {
    const hour = new Date().getHours();
    const greeting = hour < 12 ? "Good morning." : hour < 18 ? "Good afternoon." : "Good evening.";
    $("#homeGreeting").textContent = greeting;
  }

  /* ---------------------------------------------------------
     GOOGLE AUTH (Google Identity Services — token model)
     --------------------------------------------------------- */
  function initGoogleAuth() {
    if (typeof google === "undefined" || !google.accounts) {
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
    if (state.accessToken) google.accounts.oauth2.revoke(state.accessToken, () => {});
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
      $("#accountDesc").textContent = "Connected. Notes, tasks, and conversation history sync to axiom-data.json.";
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
    const metadata = { name: JARVIS_CONFIG.DATA_FILENAME, parents: ["appDataFolder"] };
    const boundary = "axiom_boundary_" + Date.now();
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
        toast("Created axiom-data.json on Drive.");
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
    }, 600);
  }

  function persist() {
    saveMemoryToDrive();
    renderAll();
  }

  /* ---------------------------------------------------------
     NOTES
     --------------------------------------------------------- */
  function createNote(title, body) {
    const note = {
      id: "n_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: title && title.trim() ? title.trim() : (body || "").slice(0, 30) || "Untitled note",
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
        query ? "No notes match your search." : 'No notes yet. Say "Axiom, save note..." or add one manually.'
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
     TASKS
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
    renderChatLog();
  }

  /* ---------------------------------------------------------
     CHAT LOG (text + voice + image conversation, with memory)
     --------------------------------------------------------- */
  function trimConversations() {
    if (state.data.conversations.length > 60) {
      state.data.conversations = state.data.conversations.slice(-60);
    }
  }

  function renderChatLog() {
    const log = $("#chatLog");
    if (!log) return;
    const msgs = state.data.conversations;
    if (!msgs.length) {
      log.innerHTML = `<div class="chat-empty">No conversation yet. Type, talk, or attach an image below.</div>`;
      return;
    }
    log.innerHTML = msgs.map((m) => {
      const cls = m.role === "user" ? "user" : "axiom";
      const imgHtml = m.image ? `<img src="${m.image}" alt="attached image">` : "";
      const textHtml = m.text ? escapeHtml(m.text) : "";
      const timeHtml = `<time>${new Date(m.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>`;
      return `<div class="chat-bubble ${cls}">${textHtml}${imgHtml}${timeHtml}</div>`;
    }).join("");
    log.scrollTop = log.scrollHeight;
  }

  function addAxiomReply(text) {
    state.data.conversations.push({ role: "axiom", text, at: new Date().toISOString() });
    trimConversations();
    persist();
    renderChatLog();
    speak(text);
  }

  async function sendChatMessage(text, imageDataUrl) {
    text = (text || "").trim();
    if (!text && !imageDataUrl) return;

    state.data.conversations.push({
      role: "user",
      text,
      image: imageDataUrl || null,
      at: new Date().toISOString()
    });
    trimConversations();
    persist();
    renderChatLog();

    let reply = null;
    if (!imageDataUrl) reply = tryLocalCommand(text);

    if (reply !== null) {
      addAxiomReply(reply);
      return;
    }

    const pendingMsg = { role: "axiom", text: "…", at: new Date().toISOString() };
    state.data.conversations.push(pendingMsg);
    renderChatLog();
    setVoiceVisualState("speaking");

    const aiReply = await callGemini(text, imageDataUrl);
    pendingMsg.text = aiReply;
    persist();
    renderChatLog();
    speak(aiReply);
  }

  /* ---------------------------------------------------------
     GEMINI (optional AI brain — free tier, no billing = no cost)
     --------------------------------------------------------- */
  async function callGemini(userText, imageDataUrl) {
    if (!JARVIS_CONFIG.GEMINI_API_KEY || JARVIS_CONFIG.GEMINI_API_KEY.startsWith("PASTE_YOUR")) {
      return "My AI brain isn't connected yet — add a free Gemini API key in config.js.";
    }
    try {
      const recent = state.data.conversations.slice(-9, -1);
      const contents = recent
        .filter((m) => m.text || m.image)
        .map((m) => {
          const parts = [];
          if (m.text) parts.push({ text: m.text });
          if (m.image) {
            const match = m.image.match(/^data:(.*?);base64,(.*)$/);
            if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
          }
          return { role: m.role === "user" ? "user" : "model", parts };
        });

      const currentParts = [];
      if (userText) currentParts.push({ text: userText });
      if (imageDataUrl) {
        const match = imageDataUrl.match(/^data:(.*?);base64,(.*)$/);
        if (match) currentParts.push({ inlineData: { mimeType: match[1], data: match[2] } });
      }
      contents.push({ role: "user", parts: currentParts });

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${JARVIS_CONFIG.GEMINI_MODEL}:generateContent?key=${JARVIS_CONFIG.GEMINI_API_KEY}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents,
          systemInstruction: {
            parts: [{ text: "You are Axiom, a concise personal AI assistant living in a phone app. Keep replies short (1-3 sentences) and conversational, since they may be read aloud." }]
          }
        })
      });
      const json = await res.json();
      if (!res.ok) {
        console.error(json);
        return "I hit an error reaching my AI brain: " + (json.error && json.error.message ? json.error.message : res.status);
      }
      const parts = json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts;
      const text = parts ? parts.map((p) => p.text || "").join(" ").trim() : "";
      return text || "I didn't get a clear response back.";
    } catch (err) {
      console.error(err);
      return "I couldn't reach the AI service — check your connection.";
    }
  }

  /* ---------------------------------------------------------
     LOCAL FAST COMMANDS (no AI needed — notes & tasks)
     --------------------------------------------------------- */
  function tryLocalCommand(raw) {
    const cmd = raw.toLowerCase().trim();
    let m;

    if ((m = cmd.match(/^(?:save|add|make|create)\s+note[s]?\s*(?:that says|saying|about)?\s*(.*)$/))) {
      const body = m[1] || raw;
      createNote(null, body || raw);
      return "I have saved your note.";
    }
    if (/^(show|read|list)\s+(my\s+)?notes?$/.test(cmd)) {
      const notes = state.data.notes.slice(0, 5);
      if (!notes.length) return "You have no notes saved.";
      retur
