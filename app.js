// Our Moon — proof of concept client. No build step on purpose.

import { drawPrompt, loadLibrary } from "./draw.js?v=63a2590";

const $ = (sel) => document.querySelector(sel);
const POLL_MS = 8000;
const SOFT_LIMIT_MS = 60_000; // the "one minute" people are aiming for
const HARD_LIMIT_MS = 90_000; // stop recording here no matter what
const WAVE_BARS = 42;
const METER_BARS = 27;
const AVATARS_SHOWN = 4;

/** Each category carries its own hue through the card, dot and rule. */
const CATEGORY_HUE = {
  "slice-of-life": 145,
  "story-time": 32,
  banter: 12,
  close: 320,
};

const ICON = {
  play: '<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor"><path d="M5 3.4c0-.6.7-1 1.2-.6l6 4.2c.5.3.5 1 0 1.3l-6 4.2c-.5.4-1.2 0-1.2-.6V3.4z"/></svg>',
  pause: '<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor"><rect x="4" y="3" width="3.2" height="10" rx="1.2"/><rect x="8.8" y="3" width="3.2" height="10" rx="1.2"/></svg>',
};

let state = null;
let pollTimer = null;

// ------------------------------------------------------------------- api

async function api(path, options = {}) {
  const res = await fetch(path, { credentials: "same-origin", ...options });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

const postJson = (path, data) =>
  api(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });

// ------------------------------------------------------------- utilities

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

function initials(name) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

function avatarStyle(hue) {
  return `background: linear-gradient(150deg, hsl(${hue} 58% 60%), hsl(${hue + 24} 54% 43%))`;
}

function clock(ms) {
  const total = Math.max(0, Math.round((ms || 0) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function ago(ts) {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

function joinedLabel(ts) {
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const then = new Date(ts);
  const days = Math.round((startOfDay(new Date()) - startOfDay(then)) / 86_400_000);
  if (days <= 0) return "joined today";
  if (days === 1) return "joined yesterday";
  if (days < 30) return `joined ${days} days ago`;
  return `joined ${then.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

function listNames(names) {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// ---------------------------------------------------------------- player

// Only one recording plays at a time — a table talks in turns.
let playing = null;

/**
 * Voice note player. The waveform is real: the clip is fetched once on first
 * play, handed to the audio element as a blob, and decoded for its peaks.
 * Until then the bars sit flat, which is honest about what we know so far.
 */
function createPlayer(url, durationMs) {
  const button = el("button", { className: "player-play", type: "button", title: "Play" });
  button.innerHTML = ICON.play;

  const wave = el("div", { className: "wave" });
  const bars = Array.from({ length: WAVE_BARS }, () => {
    const bar = el("i");
    bar.style.height = "34%";
    wave.append(bar);
    return bar;
  });

  const time = el("span", { className: "player-time", textContent: clock(durationMs) });
  const root = el("div", { className: "player" }, [button, wave, time]);

  const totalSec = Math.max(0.1, (durationMs || 0) / 1000);
  let audio = null;
  let peaks = null;
  let frame = 0;
  let loading = false;

  const paintHeights = () => {
    bars.forEach((bar, i) => {
      const level = peaks ? peaks[i] : 0.25;
      bar.style.height = `${Math.round(12 + level * 88)}%`;
    });
  };

  const paintProgress = (fraction) => {
    const edge = fraction * WAVE_BARS;
    bars.forEach((bar, i) => bar.classList.toggle("on", i < edge));
  };

  const tick = () => {
    if (!audio) return;
    const elapsed = audio.currentTime;
    paintProgress(Math.min(1, elapsed / totalSec));
    time.textContent = clock(elapsed * 1000);
    frame = requestAnimationFrame(tick);
  };

  async function load() {
    loading = true;
    const res = await fetch(url, { credentials: "same-origin" });
    if (!res.ok) throw new Error("Could not load that recording.");
    const bytes = await res.arrayBuffer();
    const type = res.headers.get("content-type") || "audio/webm";
    audio = new Audio(URL.createObjectURL(new Blob([bytes], { type })));
    audio.addEventListener("ended", () => {
      stop();
      paintProgress(0);
      time.textContent = clock(durationMs);
    });
    decodePeaks(bytes.slice(0))
      .then((result) => {
        peaks = result;
        paintHeights();
      })
      .catch(() => {});
    loading = false;
  }

  function stop() {
    cancelAnimationFrame(frame);
    audio?.pause();
    button.innerHTML = ICON.play;
    if (playing === handle) playing = null;
  }

  async function start() {
    playing?.stop();
    playing = handle;
    button.innerHTML = ICON.pause;
    try {
      if (!audio && !loading) await load();
      await audio.play();
      tick();
    } catch {
      stop();
    }
  }

  const handle = { root, stop };

  button.onclick = () => (audio && !audio.paused ? stop() : start());
  wave.onclick = (event) => {
    if (!audio) return;
    const box = wave.getBoundingClientRect();
    audio.currentTime = ((event.clientX - box.left) / box.width) * totalSec;
    paintProgress(audio.currentTime / totalSec);
  };

  paintHeights();
  return root;
}

async function decodePeaks(bytes) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  try {
    const buffer = await ctx.decodeAudioData(bytes);
    const samples = buffer.getChannelData(0);
    const step = Math.max(1, Math.floor(samples.length / WAVE_BARS));
    const peaks = [];
    for (let i = 0; i < WAVE_BARS; i++) {
      let peak = 0;
      for (let j = i * step; j < (i + 1) * step && j < samples.length; j += 6) {
        peak = Math.max(peak, Math.abs(samples[j]));
      }
      peaks.push(peak);
    }
    const loudest = Math.max(...peaks, 0.01);
    return peaks.map((p) => Math.min(1, p / loudest));
  } finally {
    ctx.close().catch(() => {});
  }
}

// -------------------------------------------------------------- screens

function show(screen) {
  $("#welcome").hidden = screen !== "welcome";
  $("#table").hidden = screen !== "table";
  $("#live").hidden = screen !== "live";
  // In-person mode needs no server at all, so the demo warning does not apply.
  const note = $("#demo-note");
  if (note) note.hidden = screen === "live";
}

async function refresh() {
  try {
    state = await api("/api/state");
    renderTable();
    if (!$("#roster").hidden) renderRoster(); // keep an open roster live as people arrive
    show("table");
    return true;
  } catch {
    state = null;
    show("welcome");
    return false;
  }
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (document.visibilityState === "visible" && $("#recorder").hidden && !playing) refresh();
  }, POLL_MS);
}

// ------------------------------------------------------------ rendering

function renderTable() {
  $("#table-name").textContent = state.table.name;
  $("#table-code").textContent = state.table.joinCode;

  // A long stack of faces stops being readable and starts pushing the header
  // off a narrow screen. Show a few, count the rest — the roster has them all.
  const shown = state.members.slice(0, AVATARS_SHOWN);
  const hidden = state.members.length - shown.length;
  $("#member-list").replaceChildren(
    ...shown.map((m) =>
      el("li", { textContent: initials(m.name), title: m.name, style: avatarStyle(m.hue) }),
    ),
    ...(hidden > 0
      ? [el("li", {
          className: "more",
          textContent: `+${hidden}`,
          title: state.members.slice(AVATARS_SHOWN).map((m) => m.name).join(", "),
        })]
      : []),
  );

  const select = $("#category-select");
  if (select.options.length <= 1) {
    for (const [key, cat] of Object.entries(state.categories)) {
      select.append(el("option", { value: key, textContent: cat.label }));
    }
  }

  const [current, ...earlier] = state.rounds;

  if (!current) {
    $("#hero").replaceChildren(
      el("div", { className: "empty" }, [
        el("img", { src: "/mark.svg", width: 56, height: 56, alt: "" }),
        el("h2", { textContent: "The table is set" }),
        el("p", {
          textContent:
            state.members.length > 1
              ? "Pull a topic and get everyone talking."
              : "Share the code above with your family, then pull the first topic.",
        }),
      ]),
    );
    $("#archive").replaceChildren();
    return;
  }

  $("#hero").replaceChildren(renderRound(current, true));
  $("#archive").replaceChildren(
    ...(earlier.length
      ? [el("h2", { className: "section-label", textContent: "Earlier at the table" }),
         ...earlier.map((r) => renderRound(r, false))]
      : []),
  );
}

function renderRound(round, featured) {
  const nameOf = (id) => state.members.find((m) => m.id === id)?.name ?? "Someone";
  const answered = round.responses.some((r) => r.mine);
  const waiting = state.members.filter((m) => !round.responses.some((r) => r.memberId === m.id));

  const eyebrow = el("p", { className: "eyebrow" }, [
    document.createTextNode(round.categoryLabel),
  ]);
  if (featured) {
    eyebrow.append(
      el("span", { className: "eyebrow-sep", textContent: "·" }),
      el("span", { className: "eyebrow-now", textContent: "on the table now" }),
    );
  }

  const head = el("div", { className: "round-head" }, [
    eyebrow,
    el("h2", { className: "prompt", textContent: round.text }),
    round.alt ? el("p", { className: "round-alt", textContent: round.alt }) : null,
    el("p", {
      className: "round-meta",
      textContent: `${nameOf(round.openedBy)} put this on the table · ${ago(round.createdAt)}`,
    }),
  ]);

  const answers = round.responses.length
    ? el("ul", { className: "answers" }, round.responses.map((r) => renderAnswer(r, nameOf(r.memberId))))
    : null;

  const status = el("p", { className: "round-status" });
  if (answered) {
    if (waiting.length) {
      status.append(
        el("span", { className: "pending" }, waiting.slice(0, 4).map(() => el("span"))),
        document.createTextNode(`Waiting on ${listNames(waiting.map((m) => m.name))}`),
      );
    } else {
      status.textContent = "Everyone has answered.";
    }
  } else {
    status.append(
      round.responses.length
        ? el("strong", { textContent: `${round.responses.length} answered` })
        : el("strong", { textContent: "Nobody has answered yet" }),
      document.createTextNode(round.responses.length ? " — your turn." : " — go first."),
    );
  }

  const foot = el("div", { className: "round-foot" }, [
    status,
    answered
      ? null
      : el("button", {
          className: "btn btn-primary",
          textContent: "Answer",
          onclick: () => openRecorder(round),
        }),
  ]);

  const article = el("article", {
    className: `round ${featured ? "round--hero" : "round--past"}`,
  }, [head, answers, foot]);
  article.style.setProperty("--cat-h", CATEGORY_HUE[round.category] ?? 14);
  return article;
}

function renderAnswer(response, name) {
  const hue = state.members.find((m) => m.id === response.memberId)?.hue ?? 20;

  const head = el("div", { className: "answer-head" }, [
    document.createTextNode(name),
    el("time", { textContent: ago(response.createdAt) }),
    response.mine
      ? el("button", {
          className: "answer-del",
          textContent: "Undo",
          title: "Remove your answer",
          onclick: async () => {
            if (!confirm("Take your answer back?")) return;
            await api(`/api/responses/${response.id}`, { method: "DELETE" });
            refresh();
          },
        })
      : null,
  ]);

  const body = el("div", { className: "answer-body" }, [head]);
  if (response.audioUrl) body.append(createPlayer(response.audioUrl, response.durationMs));
  if (response.text) body.append(el("p", { className: "answer-text", textContent: response.text }));

  return el("li", {}, [
    el("div", { className: "avatar", textContent: initials(name), style: avatarStyle(hue) }),
    body,
  ]);
}

// --------------------------------------------------------------- sheets

const anySheetOpen = () => !$("#recorder").hidden || !$("#roster").hidden;

function openSheet(id) {
  $(id).hidden = false;
  document.body.style.overflow = "hidden";
}

function closeSheet(id) {
  $(id).hidden = true;
  if (!anySheetOpen()) document.body.style.overflow = "";
}

// --------------------------------------------------------------- roster

/** Who is at this table, how they are doing on the current topic, and the code. */
function renderRoster() {
  $("#roster-title").textContent = state.table.name;
  $("#invite-code").textContent = state.table.joinCode;
  $("#invite-action").textContent = navigator.share ? "Share" : "Copy";

  const current = state.rounds[0];

  $("#roster-list").replaceChildren(
    ...state.members.map((m) => {
      const badges = [];
      if (m.id === state.me.id) badges.push("you");
      if (m.host) badges.push("host");

      const name = el("div", { className: "roster-name" }, [
        el("b", { textContent: m.name }),
        ...badges.map((text) => el("span", { className: "badge", textContent: text })),
        el("span", { textContent: joinedLabel(m.joinedAt) }),
      ]);

      let status = null;
      if (current) {
        const done = current.responses.some((r) => r.memberId === m.id);
        status = el("span", { className: `roster-state${done ? " is-done" : ""}` }, [
          el("span", { className: done ? "tick" : "dot", textContent: done ? "✓" : "" }),
          document.createTextNode(done ? "answered" : "yet to answer"),
        ]);
      }

      return el("li", {}, [
        el("div", { className: "avatar", textContent: initials(m.name), style: avatarStyle(m.hue) }),
        name,
        status,
      ]);
    }),
  );

  $("#invite-label").textContent =
    state.members.length === 1
      ? "You are the first one here. Send this code to your family."
      : "Anyone with this code can pull up a chair.";
}

function openRoster() {
  renderRoster();
  openSheet("#roster");
}

// ------------------------------------------------------------- recorder

const rec = {
  round: null,
  stream: null,
  recorder: null,
  chunks: [],
  blob: null,
  startedAt: 0,
  durationMs: 0,
  ticker: null,
  audioCtx: null,
  raf: 0,
  meterBars: [],
};

const CAPTION = {
  idle: "Tap to start. Talk like you would on the phone.",
  live: "Listening. Tap again when you have finished.",
  done: "Have a listen, then send it round.",
};

function buildMeter() {
  const meter = $("#rec-level");
  rec.meterBars = Array.from({ length: METER_BARS }, () => el("i"));
  meter.replaceChildren(...rec.meterBars);
}

function openRecorder(round) {
  rec.round = round;
  $("#rec-prompt").textContent = round.text;
  $("#rec-error").hidden = true;
  openSheet("#recorder");
  buildMeter();
  switchMode("audio");
  resetRecorder();
}

function switchMode(mode) {
  $("#rec-audio").hidden = mode !== "audio";
  $("#rec-text").hidden = mode !== "text";
  if (mode === "text") $("#rec-textarea").focus();
}

function resetRecorder() {
  stopTracks();
  rec.blob = null;
  rec.chunks = [];
  rec.durationMs = 0;
  $("#rec-time").textContent = "0:00";
  $("#rec-time").classList.remove("is-long");
  $("#rec-track").style.width = "0%";
  $("#rec-level").classList.remove("is-live");
  rec.meterBars.forEach((bar) => (bar.style.height = "3px"));
  $("#rec-stage").hidden = false;
  $("#rec-toggle").classList.remove("is-recording");
  $("#rec-toggle").hidden = false;
  $("#rec-caption").textContent = CAPTION.idle;
  $("#rec-caption").hidden = false;
  $("#rec-confirm").hidden = true;
  $("#rec-preview").hidden = true;
  $("#rec-preview").replaceChildren();
  $("#rec-textarea").value = "";
}

function closeRecorder() {
  stopTracks();
  playing?.stop();
  closeSheet("#recorder");
  rec.round = null;
}

function stopTracks() {
  cancelAnimationFrame(rec.raf);
  clearInterval(rec.ticker);
  if (rec.recorder?.state === "recording") rec.recorder.stop();
  rec.stream?.getTracks().forEach((t) => t.stop());
  rec.stream = null;
  rec.audioCtx?.close().catch(() => {});
  rec.audioCtx = null;
}

function pickMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];
  return candidates.find((t) => MediaRecorder.isTypeSupported?.(t)) ?? "";
}

function recorderUnavailable(message) {
  const box = $("#rec-error");
  box.textContent = message;
  box.hidden = false;
  switchMode("text");
}

async function startRecording() {
  $("#rec-error").hidden = true;

  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    recorderUnavailable("This browser will not record audio here. Type your answer instead.");
    return;
  }

  try {
    rec.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  } catch {
    recorderUnavailable(
      "The microphone is blocked — recording needs a secure (https) connection and your permission. You can type your answer instead.",
    );
    return;
  }

  const mimeType = pickMimeType();
  rec.recorder = new MediaRecorder(rec.stream, mimeType ? { mimeType } : undefined);
  rec.chunks = [];
  rec.recorder.ondataavailable = (e) => e.data.size && rec.chunks.push(e.data);
  rec.recorder.onstop = finishRecording;
  rec.recorder.start();
  rec.startedAt = Date.now();

  meterLevel();
  $("#rec-toggle").classList.add("is-recording");
  $("#rec-level").classList.add("is-live");
  $("#rec-caption").textContent = CAPTION.live;

  rec.ticker = setInterval(() => {
    const elapsed = Date.now() - rec.startedAt;
    $("#rec-time").textContent = clock(elapsed);
    $("#rec-time").classList.toggle("is-long", elapsed > SOFT_LIMIT_MS);
    $("#rec-track").style.width = `${Math.min(100, (elapsed / HARD_LIMIT_MS) * 100)}%`;
    if (elapsed >= HARD_LIMIT_MS) stopRecording();
  }, 200);
}

function meterLevel() {
  rec.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const analyser = rec.audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.75;
  rec.audioCtx.createMediaStreamSource(rec.stream).connect(analyser);
  const spectrum = new Uint8Array(analyser.frequencyBinCount);

  const tick = () => {
    analyser.getByteFrequencyData(spectrum);
    // Voice lives low in the spectrum; sample the useful third of the bins.
    const span = Math.floor(spectrum.length / 3 / METER_BARS);
    rec.meterBars.forEach((bar, i) => {
      let sum = 0;
      for (let j = 0; j < span; j++) sum += spectrum[i * span + j];
      const level = sum / span / 255;
      bar.style.height = `${Math.max(3, Math.min(32, level * 60))}px`;
    });
    rec.raf = requestAnimationFrame(tick);
  };
  tick();
}

function stopRecording() {
  clearInterval(rec.ticker);
  cancelAnimationFrame(rec.raf);
  rec.durationMs = Date.now() - rec.startedAt;
  if (rec.recorder?.state === "recording") rec.recorder.stop();
}

function finishRecording() {
  rec.blob = new Blob(rec.chunks, { type: rec.recorder.mimeType.split(";")[0] });
  rec.stream?.getTracks().forEach((t) => t.stop());
  rec.stream = null;

  $("#rec-toggle").classList.remove("is-recording");
  $("#rec-toggle").hidden = true;
  $("#rec-caption").textContent = CAPTION.done;
  $("#rec-level").classList.remove("is-live");
  $("#rec-stage").hidden = true;

  const preview = $("#rec-preview");
  preview.replaceChildren(createPlayer(URL.createObjectURL(rec.blob), rec.durationMs));
  preview.hidden = false;
  $("#rec-confirm").hidden = false;
}

async function sendResponse(form, button) {
  button.disabled = true;
  const box = $("#rec-error");
  box.hidden = true;
  try {
    const res = await fetch("/api/responses", {
      method: "POST",
      credentials: "same-origin",
      body: form,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || "Could not send that.");
    closeRecorder();
    await refresh();
  } catch (err) {
    box.textContent = err.message;
    box.hidden = false;
  } finally {
    button.disabled = false;
  }
}

// ------------------------------------------------------------------ wire

$("#rec-toggle").onclick = () =>
  rec.recorder?.state === "recording" ? stopRecording() : startRecording();
$("#rec-redo").onclick = resetRecorder;
$("#rec-close").onclick = closeRecorder;
$("#rec-switch-text").onclick = () => switchMode("text");
$("#rec-switch-audio").onclick = () => switchMode("audio");
$("#recorder").onclick = (e) => e.target.id === "recorder" && closeRecorder();

$("#members-btn").onclick = openRoster;
$("#roster-close").onclick = () => closeSheet("#roster");
$("#roster").onclick = (e) => e.target.id === "roster" && closeSheet("#roster");

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("#recorder").hidden) closeRecorder();
  else if (!$("#roster").hidden) closeSheet("#roster");
});

$("#invite-btn").onclick = async (e) => {
  const label = $("#invite-action");
  const message = `Join our table on Our Moon. Code: ${state.table.joinCode}`;
  try {
    if (navigator.share) {
      await navigator.share({ title: state.table.name, text: message, url: location.origin });
      return;
    }
    await navigator.clipboard.writeText(message);
    label.textContent = "Copied";
  } catch {
    label.textContent = "Select it";
  }
  setTimeout(() => (label.textContent = navigator.share ? "Share" : "Copy"), 1800);
};

$("#rec-send").onclick = (e) => {
  if (!rec.blob) return;
  const form = new FormData();
  form.set("roundId", rec.round.id);
  form.set("durationMs", String(rec.durationMs));
  form.set("mime", rec.blob.type);
  form.set("audio", rec.blob, "story");
  sendResponse(form, e.currentTarget);
};

$("#rec-send-text").onclick = (e) => {
  const text = $("#rec-textarea").value.trim();
  if (!text) return;
  const form = new FormData();
  form.set("roundId", rec.round.id);
  form.set("text", text);
  sendResponse(form, e.currentTarget);
};

$("#draw-btn").onclick = async (e) => {
  const button = e.currentTarget;
  button.disabled = true;
  try {
    await postJson("/api/rounds", { category: $("#category-select").value || undefined });
    await refresh();
    window.scrollTo({ top: 0, behavior: "smooth" });
  } finally {
    button.disabled = false;
  }
};

$("#code-btn").onclick = async (e) => {
  const label = e.currentTarget.querySelector(".code-copy");
  try {
    await navigator.clipboard.writeText(state.table.joinCode);
    label.textContent = "copied";
  } catch {
    label.textContent = "select it";
  }
  setTimeout(() => (label.textContent = "copy"), 1600);
};

$("#leave-btn").onclick = async () => {
  await api("/api/logout", { method: "POST" });
  clearInterval(pollTimer);
  location.reload();
};

for (const tab of document.querySelectorAll(".tab")) {
  tab.onclick = () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("is-active", t === tab));
    document
      .querySelectorAll(".panel")
      .forEach((p) => (p.hidden = p.dataset.panel !== tab.dataset.tab));
    $("#welcome-error").hidden = true;
  };
}

for (const [id, path] of [["#join-form", "/api/join"], ["#create-form", "/api/tables"]]) {
  $(id).onsubmit = async (event) => {
    event.preventDefault();
    const button = event.target.querySelector("button");
    const box = $("#welcome-error");
    button.disabled = true;
    box.hidden = true;
    try {
      await postJson(path, Object.fromEntries(new FormData(event.target)));
      await refresh();
      startPolling();
      // First thing you want on arrival: who is here, and the code to pass on.
      openRoster();
    } catch (err) {
      box.textContent = err.message;
      box.hidden = false;
    } finally {
      button.disabled = false;
    }
  };
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state) refresh();
});


// -------------------------------------------------------------- in person

/**
 * In-person mode: everyone is in the same room, so there is no table to join,
 * nothing to record and nothing to send anywhere. It draws from the same
 * question library by the same rules, keeps track of what this group has
 * already had, and otherwise stays out of the way.
 *
 * The whole mode is local — it runs with the network off, and on the static
 * GitHub Pages build it is the real thing rather than a demo.
 */

const LIVE_KEY = "ourmoon-in-person";

const liveBlank = () => ({ names: [], used: [], category: "", count: 0, current: null });

let live = liveBlank();
try {
  live = { ...live, ...JSON.parse(localStorage.getItem(LIVE_KEY) ?? "{}") };
} catch {
  /* a corrupt entry is not worth failing over — start fresh */
}

function liveSave() {
  try {
    localStorage.setItem(LIVE_KEY, JSON.stringify(live));
  } catch {
    /* private mode: the round still plays, it just will not survive a reload */
  }
}

function liveRenderPeople() {
  $("#live-people").replaceChildren(
    ...live.names.map((name, i) =>
      el("li", {}, [
        el("span", { className: "live-chip-name", textContent: name }),
        el("button", {
          className: "live-chip-x",
          type: "button",
          title: `Remove ${name}`,
          textContent: "×",
          onclick: () => {
            live.names.splice(i, 1);
            liveSave();
            liveRenderPeople();
            liveLabelBack();
          },
        }),
      ]),
    ),
  );

  const hint = $("#live-people-hint");
  if (live.names.length === 0) {
    hint.textContent = "Names are optional, and stay on this phone. Add two or more and the questions start using them.";
  } else if (live.names.length === 1) {
    hint.textContent = "One more and the questions can start naming people.";
  } else {
    hint.textContent = `${listNames(live.names)} — questions can name any of you.`;
  }
}

/** "Add names" until there are some, then it is a roll call. */
function liveLabelBack() {
  $("#live-back").textContent = live.names.length ? "Who is here" : "Add names";
}

function liveShow(step) {
  $("#live-setup").hidden = step !== "setup";
  $("#live-play").hidden = step !== "play";
}

/** Tell the room when a draw failed, and offer the retry on the same button. */
function liveFail(err) {
  const note = $("#live-note");
  note.textContent = err?.message || "Something went wrong drawing a question.";
  note.classList.add("is-error");
  note.hidden = false;
  $("#live-next").textContent = "Try again";
}

/**
 * Draw the next question for the room, or say so when the deck has looped.
 * Never rejects — a silent failure here reads as a dead button.
 */
async function liveDraw() {
  let library;
  try {
    library = await loadLibrary();
  } catch (err) {
    liveFail(err);
    return false;
  }

  const { prompt, text, exhausted } = drawPrompt(library, {
    usedIds: live.used,
    memberNames: live.names,
    category: live.category || undefined,
  });

  live.used.push(prompt.id);
  live.count += 1;
  live.current = {
    text,
    alt: prompt.alt ?? null,
    category: prompt.category,
    label: library.categories[prompt.category]?.label ?? prompt.category,
    // Somebody has to go first, and nobody wants to decide.
    first: live.names.length >= 2 ? live.names[Math.floor(Math.random() * live.names.length)] : null,
  };
  liveSave();
  livePaint();

  const note = $("#live-note");
  note.classList.remove("is-error");
  note.hidden = !exhausted;
  if (exhausted) note.textContent = "That is every question in the deck — going round again.";
  $("#live-next").textContent = "Next question";
  return true;
}

function livePaint() {
  const now = live.current;
  if (!now) return;

  const card = $("#live-card");
  card.style.setProperty("--cat-h", CATEGORY_HUE[now.category] ?? 231);
  $("#live-eyebrow").textContent = now.label;
  $("#live-prompt").textContent = now.text;

  const alt = $("#live-alt");
  alt.textContent = now.alt ?? "";
  alt.hidden = !now.alt;

  const first = $("#live-first");
  first.textContent = now.first ? `${now.first} goes first` : "";
  first.hidden = !now.first;

  $("#live-count").textContent = `Question ${live.count}`;

  // Re-run the entrance so each question arrives rather than swaps.
  card.style.animation = "none";
  void card.offsetWidth;
  card.style.animation = "";
}

async function liveOpen() {
  liveRenderPeople();
  liveShow("play");
  show("live");

  // Nothing to set up: the first question is already on screen when you arrive.
  if (live.current) {
    livePaint();
  } else {
    await liveDraw();
  }

  loadLibrary()
    .then((library) => {
      const select = $("#live-category");
      if (select.options.length <= 1) {
        for (const [key, cat] of Object.entries(library.categories)) {
          select.append(el("option", { value: key, textContent: cat.label }));
        }
      }
      select.value = live.category ?? "";
    })
    .catch(() => {});
}

$("#live-btn").onclick = () => {
  liveLabelBack();
  liveOpen();  // liveDraw reports its own failures, so nothing escapes here
};

$("#live-exit").onclick = () => {
  show("welcome");
  $("#demo-note")?.removeAttribute("hidden");
};

$("#live-add").onsubmit = (event) => {
  event.preventDefault();
  const input = $("#live-name");
  const name = input.value.replace(/\s+/g, " ").trim().slice(0, 40);
  input.value = "";
  input.focus();
  if (!name) return;
  if (live.names.some((n) => n.toLowerCase() === name.toLowerCase())) return;
  live.names.push(name);
  liveSave();
  liveRenderPeople();
  liveLabelBack();
};

$("#live-category").onchange = (event) => {
  live.category = event.target.value;
  liveSave();
};

$("#live-start").onclick = () => {
  liveShow("play");
  liveLabelBack();
};

$("#live-next").onclick = async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await liveDraw();
  } finally {
    button.disabled = false;
  }
};

$("#live-back").onclick = () => {
  liveRenderPeople();
  liveShow("setup");
  $("#live-name").focus();
};

// ------------------------------------------------------------------ boot

if (await refresh()) startPolling();
